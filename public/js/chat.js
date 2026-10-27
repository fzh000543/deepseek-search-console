import { runChat } from './api.js';
import { renderMarkdown } from './markdown.js';
import { buildChatMessages, buildChatPayload } from './payloads.js';
import { getChatAuth } from './payloads.js';
import { rememberExchange, state } from './state.js';
import { $, autoGrow, copyText, escapeHtml, formatDuration, scrollToBottom, setButtonBusy, toast } from './utils.js';

let messages = [];
let controller = null;
let renderQueued = false;

const emptyState = `
  <div class="empty-state">
    <div class="empty-mark">◌</div>
    <h3>开始一段对话</h3>
    <p>聊天走 OpenAI 兼容的 <code>/chat/completions</code>。搜索增强问答会把实时网页结果注入上下文。</p>
    <div class="example-chips">
      <button type="button" data-chat-example="用一段话解释量子纠缠。">解释量子纠缠</button>
      <button type="button" data-chat-example="比较 DeepSeek V4.1 Flash 与 V4 Pro 的定位和取舍。">比较模型定位</button>
      <button type="button" data-chat-example="写一个带指数退避的 Python 重试装饰器。">写重试装饰器</button>
    </div>
  </div>`;

function messageHtml(message, index) {
  const isUser = message.role === 'user';
  const roleName = isUser ? '你' : 'DeepSeek';
  const avatar = isUser ? '你' : 'DS';
  const meta = [roleName, message.elapsed ? formatDuration(message.elapsed) : '', message.usage?.total_tokens ? `${message.usage.total_tokens} tokens` : ''].filter(Boolean).join(' · ');

  let body = '';
  if (message.error) {
    body = `<p>${escapeHtml(message.error)}</p>`;
  } else if (message.content) {
    body = renderMarkdown(message.content);
  } else if (message.streaming) {
    body = '<div class="typing-dots" aria-label="生成中"><span></span><span></span><span></span></div>';
  } else {
    body = '<p class="muted">（空响应）</p>';
  }

  const reasoning = message.reasoning
    ? `<details class="reasoning-box" ${!message.content && message.streaming ? 'open' : ''}><summary>思考过程</summary><pre>${escapeHtml(message.reasoning)}</pre></details>`
    : '';

  return `
    <article class="message ${isUser ? 'user' : 'assistant'} ${message.error ? 'error' : ''}">
      <div class="message-avatar">${avatar}</div>
      <div class="message-body">
        <div class="message-meta">${escapeHtml(meta)}</div>
        <div class="message-bubble">
          <div class="markdown-body">${body}</div>
          ${reasoning}
        </div>
        ${!isUser && message.content ? `<div class="message-actions"><button class="message-action" type="button" data-copy-message="${index}">复制回答</button></div>` : ''}
      </div>
    </article>`;
}

function renderChat(scroll = false) {
  const log = $('#chatLog');
  log.innerHTML = messages.length ? messages.map(messageHtml).join('') : emptyState;
  if (scroll) scrollToBottom(log);
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderChat(true);
  });
}

function setChatBusy(busy) {
  state.chatBusy = busy;
  $('#btnStopChat').hidden = !busy;
  $('#chatInput').disabled = busy;
  const button = $('#btnSendChat');
  if (busy) {
    button.disabled = true;
    button.classList.add('loading');
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.innerHTML = '<span class="spinner"></span><span>生成中</span>';
  } else {
    setButtonBusy(button, false);
    button.disabled = false;
    $('#chatInput').disabled = false;
  }
}

async function sendChat() {
  if (state.chatBusy) return;
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;

  const userMessage = { role: 'user', content: text, createdAt: Date.now() };
  const historyForRequest = [...messages, userMessage];
  let payload;
  let auth;
  try {
    payload = buildChatPayload(buildChatMessages(historyForRequest));
    auth = getChatAuth();
  } catch (error) {
    toast(error.message, 'warning', 5000);
    return;
  }

  input.value = '';
  autoGrow(input);
  messages.push(userMessage);
  const assistant = {
    role: 'assistant',
    content: '',
    reasoning: '',
    streaming: true,
    createdAt: Date.now(),
  };
  messages.push(assistant);
  renderChat(true);

  controller = new AbortController();
  setChatBusy(true);
  const startedAt = performance.now();
  rememberExchange(payload, null);

  try {
    const result = await runChat({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      payload,
      signal: controller.signal,
      onDelta: (delta) => {
        assistant.content = delta.fullContent;
        assistant.reasoning = delta.fullReasoning;
        scheduleRender();
      },
    });
    assistant.content = result.content || assistant.content;
    assistant.reasoning = result.reasoning || assistant.reasoning;
    assistant.usage = result.usage;
    assistant.finishReason = result.finishReason;
    assistant.elapsed = performance.now() - startedAt;
    assistant.streaming = false;
    rememberExchange(payload, result.raw);
  } catch (error) {
    assistant.streaming = false;
    assistant.elapsed = performance.now() - startedAt;
    if (error.name === 'AbortError') {
      assistant.error = assistant.content ? '' : '已停止生成';
      toast('已停止生成', 'warning');
    } else {
      assistant.error = error.requestId
        ? `${error.message}（请求 ID: ${error.requestId}）`
        : error.message;
      rememberExchange(payload, error.payload || { error: { message: error.message } });
      toast(error.message, 'error', 6500);
    }
  } finally {
    controller = null;
    setChatBusy(false);
    renderChat(true);
    input.focus();
  }
}

function clearChat() {
  if (state.chatBusy) controller?.abort();
  messages = [];
  renderChat();
  toast('对话已清空', 'success');
}

function updateHint() {
  const config = state.config;
  $('#chatHint').textContent = [
    config.stream ? '流式输出' : '非流式输出',
    config.thinking ? `思考模式 / ${config.reasoningEffort}` : '非思考模式',
    config.model,
  ].filter(Boolean).join(' · ');
}

export function initChat() {
  renderChat();
  updateHint();

  $('#btnSendChat').addEventListener('click', sendChat);
  $('#btnStopChat').addEventListener('click', () => controller?.abort());
  $('#btnClearChat').addEventListener('click', clearChat);

  const input = $('#chatInput');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChat();
    }
  });

  $('#chatLog').addEventListener('click', async (event) => {
    const copyButton = event.target.closest('[data-copy-message]');
    if (copyButton) {
      const message = messages[Number(copyButton.dataset.copyMessage)];
      if (!message?.content) return;
      try {
        await copyText(message.content);
        toast('已复制回答', 'success');
      } catch (error) {
        toast(error.message, 'error');
      }
      return;
    }
    const example = event.target.closest('[data-chat-example]');
    if (example) {
      input.value = example.dataset.chatExample;
      autoGrow(input);
      input.focus();
    }
  });

  document.addEventListener('config-changed', updateHint);
}

export function resetChat() {
  if (state.chatBusy) controller?.abort();
  messages = [];
  renderChat();
}
