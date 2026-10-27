import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_PORT = 3129;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
let app;
let upstream;
let upstreamUrl;
let lastSearchBody;

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

before(async () => {
  upstream = createServer(async (req, res) => {
    const bodyText = await readBody(req);
    if (req.headers.authorization !== 'Bearer test-key') {
      json(res, 401, { error: { message: 'bad key' } });
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      json(res, 200, { object: 'list', data: [{ id: 'deepseek/deepseek-v4.1-flash' }] });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/tools/search') {
      const body = JSON.parse(bodyText);
      lastSearchBody = body;
      if (body.query === 'force-error') {
        json(res, 400, { error: { message: "'count' must be between 1 and 50", type: 'invalid_request_error' } });
        return;
      }
      json(res, 200, {
        results: [{
          rerank_score: 2.4,
          title: 'Example result',
          url: 'https://example.com/article',
          snippet: 'Snippet text',
          summary: 'Summary text',
          content: '# Example\n\nContent',
          site_name: 'Example',
          site_icon: null,
          date: '2026-10-17T09:00:12.045Z',
          authority: 4,
        }],
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/tools/fetch') {
      json(res, 200, { title: 'Fetched page', content: '# Hello\n\nFetched content.' });
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = JSON.parse(bodyText);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.write('data: {"choices":[{"delta":{"role":"assistant","reasoning_content":"think "},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop","index":0}],"usage":{"total_tokens":12}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        json(res, 200, {
          id: 'chatcmpl-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from mock' }, finish_reason: 'stop' }],
          usage: { total_tokens: 9 },
        });
      }
      return;
    }
    json(res, 404, { error: { message: 'Invalid URL' } });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  upstreamUrl = `http://127.0.0.1:${address.port}/v1`;

  app = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${APP_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // server still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('App server did not start');
});

after(async () => {
  app?.kill();
  upstream?.close();
});

test('serves the web app', async () => {
  const response = await fetch(`${APP_URL}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /DeepSeek Search Console/);
});

test('proxies standalone search and forwards all search fields', async () => {
  const payload = {
    query: 'deepseek test',
    count: 7,
    ori_question: 'original question',
    localization: '1.2.3.4',
    need_content: true,
  };
  const response = await fetch(`${APP_URL}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: upstreamUrl, apiKey: 'test-key', payload }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.results[0].title, 'Example result');
  assert.deepEqual(lastSearchBody, payload);
});

test('proxies non-streaming chat', async () => {
  const response = await fetch(`${APP_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: upstreamUrl,
      apiKey: 'test-key',
      payload: { model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: false },
    }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].message.content, 'Hello from mock');
});

test('streams SSE without buffering', async () => {
  const response = await fetch(`${APP_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: upstreamUrl,
      apiKey: 'test-key',
      payload: { model: 'test', messages: [{ role: 'user', content: 'hi' }], stream: true },
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  assert.match(text, /Hello/);
  assert.match(text, /\[DONE\]/);
});

test('proxies page fetch', async () => {
  const response = await fetch(`${APP_URL}/api/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: upstreamUrl, apiKey: 'test-key', payload: { url: 'https://example.com' } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, 'Fetched page');
});

test('forwards upstream errors and status', async () => {
  const response = await fetch(`${APP_URL}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: upstreamUrl, apiKey: 'test-key', payload: { query: 'force-error' } }),
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.match(data.error.message, /between 1 and 50/);
});
