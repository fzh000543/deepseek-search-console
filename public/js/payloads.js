import { state } from './state.js';
import { parseJsonObject, parseNumber } from './utils.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function requireChatConfig() {
  const { chatBaseUrl, chatApiKey, model } = state.config;
  if (!chatBaseUrl.trim()) throw new Error('请填写聊天 Base URL');
  if (!chatApiKey.trim()) throw new Error('请填写聊天 API Key');
  if (!model.trim()) throw new Error('请填写模型名称');
}

export function getSearchAuth() {
  const { reuseSearchKey, chatApiKey, searchApiKey, searchBaseUrl } = state.config;
  if (!searchBaseUrl.trim()) throw new Error('请填写搜索/抓取 Base URL');
  const apiKey = reuseSearchKey ? chatApiKey : searchApiKey;
  if (!apiKey.trim()) throw new Error('请填写搜索/抓取 API Key，或勾选复用聊天 Key');
  return { baseUrl: searchBaseUrl.trim(), apiKey: apiKey.trim() };
}

export function getChatAuth() {
  requireChatConfig();
  return {
    baseUrl: state.config.chatBaseUrl.trim(),
    apiKey: state.config.chatApiKey.trim(),
  };
}

export function buildChatPayload(messages) {
  const config = state.config;
  requireChatConfig();

  const payload = {
    model: config.model.trim(),
    messages,
    stream: Boolean(config.stream),
    temperature: clamp(parseNumber(config.temperature, 0.7), 0, 2),
    top_p: clamp(parseNumber(config.topP, 0.95), 0, 1),
    max_tokens: Math.max(1, Math.round(parseNumber(config.maxTokens, 4096))),
    n: clamp(Math.round(parseNumber(config.n, 1)), 1, 10),
    presence_penalty: clamp(parseNumber(config.presencePenalty, 0), -2, 2),
    frequency_penalty: clamp(parseNumber(config.frequencyPenalty, 0), -2, 2),
    thinking: { type: config.thinking ? 'enabled' : 'disabled' },
    reasoning_effort: config.reasoningEffort,
  };

  if (String(config.seed).trim() !== '') {
    payload.seed = Math.round(parseNumber(config.seed, 0));
  }

  const stop = String(config.stop || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
  if (stop.length) payload.stop = stop;

  if (config.responseFormat === 'json_object') {
    payload.response_format = { type: 'json_object' };
  } else if (config.responseFormat === 'json_schema') {
    const schema = parseJsonObject(config.jsonSchema, 'JSON Schema');
    if (!schema) throw new Error('选择 json_schema 时需要填写 JSON Schema');
    payload.response_format = { type: 'json_schema', json_schema: schema };
  }

  const overrides = parseJsonObject(config.advancedJson, '高级覆盖 JSON');
  if (overrides) Object.assign(payload, overrides);
  return payload;
}

export function buildSearchPayload(query) {
  const config = state.config;
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new Error('请输入搜索词');
  if (trimmed.length > 128) throw new Error('搜索词不能超过 128 个字符');

  const payload = {
    query: trimmed,
    count: clamp(Math.round(parseNumber(config.searchCount, 10)), 1, 50),
    need_content: Boolean(config.needContent),
  };
  if (String(config.oriQuestion || '').trim()) {
    payload.ori_question = String(config.oriQuestion).trim().slice(0, 128);
  }
  if (String(config.localization || '').trim()) {
    payload.localization = String(config.localization).trim();
  }
  return payload;
}

export function buildChatMessages(history) {
  const messages = [];
  if (String(state.config.systemPrompt || '').trim()) {
    messages.push({ role: 'system', content: String(state.config.systemPrompt).trim() });
  }
  for (const message of history) {
    if (!message.content) continue;
    messages.push({ role: message.role, content: message.content });
  }
  return messages;
}

function truncate(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n…（内容已截断）`;
}

export function buildAgentMessages(question, results) {
  const config = state.config;
  const system = [
    String(config.systemPrompt || '').trim(),
    '你正在进行联网检索增强回答。必须优先依据给出的搜索结果作答，不要编造未出现的事实。',
    '在使用了某条来源的句子末尾标注来源编号，例如 [1] 或 [2][3]。若来源之间冲突，请指出差异。',
    '如果搜索结果不足以回答，请明确说明“现有结果不足”，并给出仍需核实的信息。',
    '请使用中文，先给结论，再给必要的细节和依据。',
  ].filter(Boolean).join('\n');

  let budget = 52000;
  const sourceText = results.map((result, index) => {
    const content = result.content
      ? truncate(result.content, Math.max(500, Math.min(5000, budget)))
      : '';
    budget -= content.length;
    return [
      `[${index + 1}] ${result.title || '未命名页面'}`,
      `URL: ${result.url || ''}`,
      result.site_name ? `站点: ${result.site_name}` : '',
      result.date ? `日期: ${result.date}` : '',
      result.summary ? `摘要: ${result.summary}` : '',
      result.snippet ? `片段: ${result.snippet}` : '',
      content ? `正文:\n${content}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: `问题：${question}\n\n以下是联网搜索结果：\n\n${sourceText}` },
  ];
}
