import { initChat, resetChat } from './chat.js';
import { initInspector } from './inspector.js';
import { initSearch, resetAgent, resetFetch, resetSearch } from './search.js';
import { closeMobileSidebar, initSettings } from './settings.js';
import { state } from './state.js';
import { $, $$, toast } from './utils.js';

let activeMode = 'chat';

function switchMode(mode) {
  if (!['chat', 'search', 'agent', 'fetch'].includes(mode)) return;
  activeMode = mode;
  $$('.mode-tab').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  $$('.panel').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== mode;
  });
  closeMobileSidebar();

  if (mode === 'chat') $('#chatInput')?.focus();
  if (mode === 'search') $('#searchQuery')?.focus();
  if (mode === 'agent') $('#agentQuery')?.focus();
  if (mode === 'fetch') $('#fetchUrl')?.focus();
}

function clearCurrentMode() {
  if (stateIsBusy()) {
    toast('当前有请求进行中，请稍候', 'warning');
    return;
  }
  if (activeMode === 'chat') {
    resetChat();
    toast('对话已清空', 'success');
  } else if (activeMode === 'search') {
    resetSearch();
    toast('搜索结果已清空', 'success');
  } else if (activeMode === 'agent') {
    resetAgent();
    toast('回答已清空', 'success');
  } else if (activeMode === 'fetch') {
    resetFetch();
    toast('抓取结果已清空', 'success');
  }
}

function stateIsBusy() {
  return ['chatBusy', 'searchBusy', 'agentBusy', 'fetchBusy'].some((key) => state[key]);
}

function init() {
  initSettings();
  initInspector();
  initChat();
  initSearch();

  $$('.mode-tab').forEach((button) => {
    button.addEventListener('click', () => switchMode(button.dataset.mode));
  });
  $('#btnClearAll').addEventListener('click', clearCurrentMode);

  const hashMode = location.hash.replace(/^#/, '');
  switchMode(['chat', 'search', 'agent', 'fetch'].includes(hashMode) ? hashMode : 'chat');
}

init();
