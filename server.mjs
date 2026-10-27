import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { getEmbeddedAsset, isStandalone } from './lib/sea-assets.mjs';

const ROOT = resolve(process.env.APP_ROOT || process.cwd());
const PUBLIC_DIR = join(ROOT, 'public');
const DEFAULT_PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 240000);
const IS_PACKAGED = isStandalone();
const OPEN_BROWSER = process.env.OPEN_BROWSER === '1' || (IS_PACKAGED && process.env.OPEN_BROWSER !== '0');
const MAX_PORT_ATTEMPTS = 20;

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: http: https:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, '请求体过大');
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

function resolveEndpoint(baseUrl, suffix) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    throw new HttpError(400, 'Base URL 不能为空');
  }
  let url;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new HttpError(400, 'Base URL 格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new HttpError(400, 'Base URL 只支持 http/https');
  }
  if (url.username || url.password) {
    throw new HttpError(400, 'Base URL 不能包含用户名或密码');
  }

  let pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname) pathname = '/v1';
  if (!pathname.endsWith(suffix)) pathname += suffix;
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url;
}

function upstreamHeaders(apiKey, accept) {
  const headers = {
    Accept: accept || 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'deepseek-search-console/1.0',
  };
  if (apiKey && String(apiKey).trim()) {
    headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  }
  return headers;
}

async function pipeUpstream(res, upstream, timeout) {
  const contentType = upstream.headers.get('content-type') || 'application/json; charset=utf-8';
  const headers = {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
    'X-Accel-Buffering': 'no',
  };
  const requestId = upstream.headers.get('x-request-id') || upstream.headers.get('x-oneapi-request-id');
  if (requestId) headers['X-Upstream-Request-Id'] = requestId;

  res.writeHead(upstream.status, headers);
  res.flushHeaders?.();

  const cleanup = () => clearTimeout(timeout);
  res.on('finish', cleanup);
  res.on('close', cleanup);

  if (!upstream.body) {
    res.end();
    return;
  }

  const source = Readable.fromWeb(upstream.body);
  source.on('error', (error) => {
    if (!res.writableEnded) {
      console.error('Upstream stream error:', error.message);
      res.destroy(error);
    }
  });
  source.pipe(res);
}

async function forwardRequest({ res, target, apiKey, method = 'POST', body, accept }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('上游请求超时')), UPSTREAM_TIMEOUT_MS);
  let clientDisconnected = false;

  const onClose = () => {
    if (!res.writableEnded) {
      clientDisconnected = true;
      controller.abort(new Error('客户端已断开'));
    }
  };
  res.on('close', onClose);

  try {
    const upstream = await fetch(target, {
      method,
      headers: upstreamHeaders(apiKey, accept),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    res.off('close', onClose);
    await pipeUpstream(res, upstream, timeout);
  } catch (error) {
    clearTimeout(timeout);
    res.off('close', onClose);
    if (clientDisconnected || res.headersSent) return;
    const message = error?.name === 'AbortError'
      ? '上游请求超时或已中止'
      : `无法连接上游接口：${error?.message || '未知错误'}`;
    sendJson(res, 502, { error: { message, type: 'proxy_error' } });
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: { message: '仅支持 POST 请求', type: 'invalid_request_error' } });
    return;
  }

  try {
    const input = await readJson(req);
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey : '';

    if (pathname === '/api/models') {
      const target = resolveEndpoint(input.baseUrl, '/models');
      await forwardRequest({ res, target, apiKey, method: 'GET', accept: 'application/json' });
      return;
    }

    if (pathname === '/api/chat') {
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        throw new HttpError(400, 'payload 必须是 JSON 对象');
      }
      const target = resolveEndpoint(input.baseUrl, '/chat/completions');
      const accept = input.payload.stream ? 'text/event-stream' : 'application/json';
      await forwardRequest({ res, target, apiKey, body: input.payload, accept });
      return;
    }

    if (pathname === '/api/search') {
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        throw new HttpError(400, 'payload 必须是 JSON 对象');
      }
      const target = resolveEndpoint(input.baseUrl, '/tools/search');
      await forwardRequest({ res, target, apiKey, body: input.payload });
      return;
    }

    if (pathname === '/api/fetch') {
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
        throw new HttpError(400, 'payload 必须是 JSON 对象');
      }
      const target = resolveEndpoint(input.baseUrl, '/tools/fetch');
      await forwardRequest({ res, target, apiKey, body: input.payload });
      return;
    }

    throw new HttpError(404, '未知 API 路径');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : '服务器内部错误';
    sendJson(res, status, { error: { message, type: 'proxy_error' } });
  }
}

async function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  let relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  if (relative.includes('\0') || relative.split('/').includes('..') || relative.startsWith('.')) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  let filePath = resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403, SECURITY_HEADERS);
    res.end('Forbidden');
    return;
  }

  const embedded = getEmbeddedAsset(relative.replaceAll('\\', '/'));
  if (embedded) {
    const type = MIME_TYPES[extname(relative).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      'Content-Length': embedded.length,
      'Content-Type': type,
    });
    res.end(req.method === 'HEAD' ? undefined : embedded);
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = join(filePath, 'index.html');
    }
    const data = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      'Content-Length': data.length,
      'Content-Type': type,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
}

function createAppServer() {
  return createServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
    } catch {
      sendJson(res, 400, { error: { message: '请求 URL 无效', type: 'invalid_request_error' } });
      return;
    }

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    await serveStatic(req, res, pathname);
  });
}

function openInBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    // Opening the browser is a convenience; the printed URL remains available.
  }
}

function listenWithFallback(port, attemptsLeft = MAX_PORT_ATTEMPTS) {
  const server = createAppServer();
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && !process.env.PORT && attemptsLeft > 0) {
      console.warn(`Port ${port} is in use, trying ${port + 1}...`);
      listenWithFallback(port + 1, attemptsLeft - 1);
      return;
    }
    console.error(`Unable to start DeepSeek Search Console: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${HOST}:${actualPort}`;
    console.log(`DeepSeek Search Console running at ${url}`);
    console.log('API keys stay in your browser and are only relayed by this local server.');
    if (OPEN_BROWSER) openInBrowser(url);
  });
}

const initialPort = Number.isInteger(DEFAULT_PORT) && DEFAULT_PORT > 0 ? DEFAULT_PORT : 3000;
listenWithFallback(initialPort);
