const STORAGE_KEY = 'deepseek-search-console.config.v1';

export const DEFAULTS = Object.freeze({
  chatBaseUrl: 'https://api.deepseek.com/v1',
  chatApiKey: '',
  model: 'deepseek-chat',
  searchBaseUrl: 'https://api.deepseek.com/v1',
  searchApiKey: '',
  reuseSearchKey: false,
  systemPrompt: '你是一个严谨、清晰的中文助手。优先给出直接答案，再补充必要依据；不确定时明确说明。',
  temperature: 0.7,
  topP: 0.95,
  maxTokens: 4096,
  n: 1,
  presencePenalty: 0,
  frequencyPenalty: 0,
  seed: '',
  stream: true,
  thinking: true,
  reasoningEffort: 'high',
  stop: '',
  responseFormat: 'text',
  jsonSchema: '',
  advancedJson: '',
  searchCount: 10,
  oriQuestion: '',
  localization: '',
  needContent: false,
  theme: 'system',
});

export function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage can be unavailable in private browsing; the app still works.
  }
}

export function clearConfig() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
