import { DEFAULTS, clearConfig, saveConfig } from './config.js';
import { testModels } from './api.js';
import { state } from './state.js';
import { $, debounce, setButtonBusy, toast } from './utils.js';

const configFields = {
  cfgChatBaseUrl: 'chatBaseUrl',
  cfgChatKey: 'chatApiKey',
  cfgSearchBaseUrl: 'searchBaseUrl',
  cfgSearchKey: 'searchApiKey',
  cfgSystemPrompt: 'systemPrompt',
  cfgTemperature: 'temperature',
  cfgTopP: 'topP',
  cfgMaxTokens: 'maxTokens',
  cfgN: 'n',
  cfgPresencePenalty: 'presencePenalty',
  cfgFrequencyPenalty: 'frequencyPenalty',
  cfgSeed: 'seed',
  cfgReasoningEffort: 'reasoningEffort',
  cfgStop: 'stop',
  cfgResponseFormat: 'responseFormat',
  cfgJsonSchema: 'jsonSchema',
  cfgAdvancedJson: 'advancedJson',
  cfgSearchCount: 'searchCount',
  cfgOriQuestion: 'oriQuestion',
  cfgLocalization: 'localization',
};

const booleanFields = {
  cfgStream: 'stream',
  cfgThinking: 'thinking',
  cfgNeedContent: 'needContent',
  cfgReuseKey: 'reuseSearchKey',
};

const saveDebounced = debounce(() => saveConfig(state.config), 180);
let verifiedModels = [];
let modelsLoaded = false;

function normalizeModels(data) {
  const source = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = source
    .map((item) => typeof item === 'string' ? item : item?.id)
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  return [...new Set(ids)];
}

function syncModelField() {
  const select = $('#cfgModel');
  if (!select) return;
  const currentModel = String(state.config.model || '');
  const stateLabel = $('#modelLoadState');
  const hint = $('#modelPickerHint');

  if (!modelsLoaded) {
    select.replaceChildren(new Option(currentModel ? `${currentModel}（待验证）` : '测试连接后选择模型', currentModel));
    select.disabled = true;
    stateLabel.textContent = '等待连接测试';
    hint.textContent = '连接成功后，将从当前地址的 /models 返回结果中加载可选模型。';
    return;
  }

  if (!verifiedModels.length) {
    select.replaceChildren(new Option(currentModel ? `${currentModel}（未返回）` : '接口未返回模型', currentModel));
    select.disabled = true;
    stateLabel.textContent = '未返回模型';
    hint.textContent = '连接正常，但 /models 未返回可用模型。请检查中转站是否支持模型列表接口。';
    return;
  }

  select.replaceChildren(...verifiedModels.map((model) => new Option(model, model)));
  const nextModel = verifiedModels.includes(currentModel) ? currentModel : verifiedModels[0];
  select.value = nextModel;
  select.disabled = false;
  stateLabel.textContent = `${verifiedModels.length} 个可用`;
  hint.textContent = '仅列出本次连接测试通过的模型；切换后会立即用于后续请求。';

  if (nextModel !== currentModel) {
    state.config.model = nextModel;
    saveConfig(state.config);
    notifyConfigChange();
  }
}

function syncResponseFormat() {
  $('#schemaField').hidden = state.config.responseFormat !== 'json_schema';
}

function syncSearchKeyState() {
  const input = $('#cfgSearchKey');
  input.disabled = state.config.reuseSearchKey;
  input.placeholder = state.config.reuseSearchKey ? '正在复用聊天 API Key' : '独立搜索接口的 Key';
}

function syncRanges() {
  $('#cfgTemperatureRange').value = state.config.temperature;
  $('#cfgTemperature').value = state.config.temperature;
  $('#cfgTopPRange').value = state.config.topP;
  $('#cfgTopP').value = state.config.topP;
}

export function applyConfigToForm() {
  for (const [id, key] of Object.entries(configFields)) {
    const element = $(`#${id}`);
    if (element) element.value = state.config[key] ?? '';
  }
  for (const [id, key] of Object.entries(booleanFields)) {
    const element = $(`#${id}`);
    if (element) element.checked = Boolean(state.config[key]);
  }
  syncRanges();
  syncResponseFormat();
  syncSearchKeyState();
  syncModelField();
}

function notifyConfigChange() {
  document.dispatchEvent(new CustomEvent('config-changed', { detail: state.config }));
}

function updateConfig(key, value) {
  state.config[key] = value;
  saveDebounced();
  notifyConfigChange();
}

function bindFieldEvents() {
  for (const [id, key] of Object.entries(configFields)) {
    const element = $(`#${id}`);
    element?.addEventListener('input', () => updateConfig(key, element.value));
    element?.addEventListener('change', () => updateConfig(key, element.value));
  }

  $('#cfgModel').addEventListener('change', () => {
    if ($('#cfgModel').value) updateConfig('model', $('#cfgModel').value);
  });

  for (const [id, key] of Object.entries(booleanFields)) {
    const element = $(`#${id}`);
    element?.addEventListener('change', () => {
      updateConfig(key, element.checked);
      if (key === 'reuseSearchKey') syncSearchKeyState();
    });
  }

  const temperatureRange = $('#cfgTemperatureRange');
  const temperature = $('#cfgTemperature');
  temperatureRange.addEventListener('input', () => {
    temperature.value = temperatureRange.value;
    updateConfig('temperature', temperatureRange.value);
  });
  temperature.addEventListener('input', () => {
    temperatureRange.value = temperature.value;
    updateConfig('temperature', temperature.value);
  });

  const topPRange = $('#cfgTopPRange');
  const topP = $('#cfgTopP');
  topPRange.addEventListener('input', () => {
    topP.value = topPRange.value;
    updateConfig('topP', topPRange.value);
  });
  topP.addEventListener('input', () => {
    topPRange.value = topP.value;
    updateConfig('topP', topP.value);
  });

  $('#cfgResponseFormat').addEventListener('change', syncResponseFormat);
}

function applyTheme() {
  let theme = state.config.theme;
  if (theme === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  state.config.theme = current === 'dark' ? 'light' : 'dark';
  saveConfig(state.config);
  applyTheme();
}

function openSidebar() {
  const sidebar = $('#sidebar');
  const trigger = $('#btnSettings');
  document.body.classList.add('sidebar-open');
  sidebar.removeAttribute('inert');
  sidebar.setAttribute('aria-hidden', 'false');
  trigger.setAttribute('aria-expanded', 'true');
  trigger.setAttribute('aria-label', '关闭设置');
  trigger.title = '关闭设置';
  window.setTimeout(() => $('#btnCloseSidebar')?.focus(), 220);
}

function closeSidebar(restoreFocus = true) {
  const sidebar = $('#sidebar');
  const trigger = $('#btnSettings');
  const wasOpen = document.body.classList.contains('sidebar-open');
  document.body.classList.remove('sidebar-open');
  sidebar.setAttribute('inert', '');
  sidebar.setAttribute('aria-hidden', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', '打开设置');
  trigger.title = '打开设置';
  if (wasOpen && restoreFocus) trigger.focus();
}

function setConnectionState(kind, text, detail) {
  const badge = $('#connectionBadge');
  badge.classList.remove('ok', 'error', 'loading');
  if (kind) badge.classList.add(kind);
  $('#connectionBadgeText').textContent = text;
  $('#connectionDetail').textContent = detail || text;
  $('#connectionDetail').className = `inline-status ${kind === 'ok' ? 'ok' : kind === 'error' ? 'error' : ''}`;
}

async function checkConnection(showToast = false) {
  const baseUrl = state.config.chatBaseUrl.trim();
  const apiKey = state.config.chatApiKey.trim();
  if (!baseUrl) {
    setConnectionState('error', '缺少地址', '请填写聊天 Base URL');
    return;
  }
  if (!apiKey) {
    setConnectionState('error', '缺少 Key', '请填写聊天 API Key');
    return;
  }
  const button = $('#btnTestConnection');
  setButtonBusy(button, true, '测试中');
  setConnectionState('loading', '连接中', '正在请求 /models');
  try {
    const data = await testModels({ baseUrl, apiKey });
    verifiedModels = normalizeModels(data);
    modelsLoaded = true;
    syncModelField();
    const count = verifiedModels.length;
    const listed = verifiedModels.slice(0, 5).join('、');
    $('#btnTestConnection').title = listed || '';
    setConnectionState('ok', '连接正常', count ? `连接正常 · ${count} 个模型` : '连接正常 · 未返回模型');
    if (showToast) toast(count ? `连接正常，已加载 ${count} 个可选模型` : '连接正常，但未返回模型列表', count ? 'success' : 'warning');
  } catch (error) {
    verifiedModels = [];
    modelsLoaded = false;
    syncModelField();
    const suffix = error.requestId ? `（请求 ID: ${error.requestId}）` : '';
    setConnectionState('error', `连接失败 ${error.status || ''}`.trim(), `${error.message}${suffix}`);
    if (showToast) toast(error.message, 'error', 6000);
  } finally {
    setButtonBusy(button, false);
  }
}

function resetConfig() {
  if (!window.confirm('确定恢复默认配置吗？API Key 也会被清除。')) return;
  clearConfig();
  state.config = { ...DEFAULTS };
  verifiedModels = [];
  modelsLoaded = false;
  applyConfigToForm();
  saveConfig(state.config);
  applyTheme();
  setConnectionState('', '未验证连接', '尚未测试');
  notifyConfigChange();
  toast('已恢复默认配置', 'success');
}

export function initSettings() {
  applyConfigToForm();
  applyTheme();
  bindFieldEvents();

  document.querySelectorAll('.section-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.closest('.setting-section');
      section.dataset.open = section.dataset.open === 'false' ? 'true' : 'false';
    });
  });

  document.querySelectorAll('[data-toggle-password]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $(`#${button.dataset.togglePassword}`);
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      button.textContent = reveal ? '隐藏' : '显示';
    });
  });

  $('#btnTestConnection').addEventListener('click', () => checkConnection(true));
  $('#connectionBadge').addEventListener('click', () => checkConnection(true));
  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnSettings').addEventListener('click', () => {
    if (document.body.classList.contains('sidebar-open')) closeSidebar();
    else openSidebar();
  });
  $('#btnCloseSidebar').addEventListener('click', () => closeSidebar());
  $('#sidebarBackdrop').addEventListener('click', () => closeSidebar());
  $('#btnResetConfig').addEventListener('click', resetConfig);
  $('#btnOfficialSearch').addEventListener('click', () => {
    state.config.searchBaseUrl = 'https://api.deepseek.com/v1';
    $('#cfgSearchBaseUrl').value = state.config.searchBaseUrl;
    saveConfig(state.config);
    notifyConfigChange();
    toast('已填入 DeepSeek 官方搜索端点', 'success');
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.config.theme === 'system') applyTheme();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSidebar();
  });
}

export function closeMobileSidebar() {
  closeSidebar(false);
}
