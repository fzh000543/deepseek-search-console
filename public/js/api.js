export class ApiError extends Error {
  constructor(message, status = 0, payload = null, requestId = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
    this.requestId = requestId;
  }
}

async function readError(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    // ignore
  }
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // keep text
  }
  const message = payload?.error?.message
    || payload?.message
    || payload?.error?.code
    || text
    || `HTTP ${response.status}`;
  const requestId = response.headers.get('x-upstream-request-id') || '';
  return new ApiError(String(message), response.status, payload, requestId);
}

async function postProxy(path, body, signal) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return response;
}

function applyDelta(target, delta = {}) {
  if (typeof delta.content === 'string' && delta.content) {
    target.content += delta.content;
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    target.reasoning += delta.reasoning_content;
  }
}

async function consumeSse(response, onDelta) {
  const result = { content: '', reasoning: '', usage: null, finishReason: '', raw: [] };
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('上游没有返回可读取的流', response.status);

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const processLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      finished = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    result.raw.push(event);
    if (event?.error) {
      throw new ApiError(event.error.message || '流式响应返回错误', response.status, event);
    }
    if (event?.type && /error|failed/.test(event.type)) {
      throw new ApiError(event.message || event.error?.message || '流式响应失败', response.status, event);
    }

    const choice = event?.choices?.[0];
    if (choice) {
      const beforeContent = result.content.length;
      const beforeReasoning = result.reasoning.length;
      applyDelta(result, choice.delta || {});
      result.finishReason = choice.finish_reason || result.finishReason;
      if (choice.delta?.content || choice.delta?.reasoning_content) {
        onDelta?.({
          content: result.content.slice(beforeContent),
          reasoning: result.reasoning.slice(beforeReasoning),
          fullContent: result.content,
          fullReasoning: result.reasoning,
        });
      }
    }
    if (event?.usage) result.usage = event.usage;
  };

  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      processLine(line);
      if (finished) break;
    }
  }
  if (buffer.trim()) processLine(buffer);
  return result;
}

export async function runChat({ baseUrl, apiKey, payload, onDelta, signal }) {
  const response = await postProxy('/api/chat', { baseUrl, apiKey, payload }, signal);
  const contentType = response.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');

  if (payload.stream && !isJson) {
    return consumeSse(response, onDelta);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError(`上游返回了无法解析的响应：${error.message}`, response.status);
  }
  const choice = data?.choices?.[0];
  return {
    content: choice?.message?.content || '',
    reasoning: choice?.message?.reasoning_content || '',
    usage: data?.usage || null,
    finishReason: choice?.finish_reason || '',
    raw: data,
  };
}

export async function runSearch({ baseUrl, apiKey, payload }) {
  const response = await postProxy('/api/search', { baseUrl, apiKey, payload });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError(`搜索接口返回了无法解析的响应：${error.message}`, response.status);
  }
  if (!Array.isArray(data?.results)) {
    throw new ApiError(data?.error?.message || '搜索接口没有返回 results 数组', response.status, data);
  }
  return { results: data.results, raw: data };
}

export async function runFetch({ baseUrl, apiKey, payload }) {
  const response = await postProxy('/api/fetch', { baseUrl, apiKey, payload });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError(`抓取接口返回了无法解析的响应：${error.message}`, response.status);
  }
  return { title: data?.title || '', content: data?.content || '', raw: data };
}

export async function testModels({ baseUrl, apiKey }) {
  const response = await postProxy('/api/models', { baseUrl, apiKey });
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new ApiError(`模型列表返回了无法解析的响应：${error.message}`, response.status);
  }
  if (data?.error) {
    throw new ApiError(data.error.message || '模型列表请求失败', response.status, data);
  }
  return data;
}
