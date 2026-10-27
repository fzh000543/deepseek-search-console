import { state } from './state.js';
import { $, copyText, prettyJson, toast } from './utils.js';

let activeTab = 'request';

function currentText() {
  return activeTab === 'request' ? prettyJson(state.lastRequest) : prettyJson(state.lastResponse);
}

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('[data-raw-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.rawTab === tab);
  });
  $('#rawRequest').classList.toggle('active', tab === 'request');
  $('#rawResponse').classList.toggle('active', tab === 'response');
}

export function openInspector(title = '原始请求 / 响应') {
  $('#rawTitle').textContent = title;
  $('#rawRequest').textContent = prettyJson(state.lastRequest);
  $('#rawResponse').textContent = prettyJson(state.lastResponse);
  setTab('request');
  const dialog = $('#rawDialog');
  if (!dialog.open) dialog.showModal();
}

export function initInspector() {
  document.querySelectorAll('[data-raw-tab]').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.rawTab));
  });
  $('#btnCloseRaw').addEventListener('click', () => $('#rawDialog').close());
  $('#rawDialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });
  $('#btnCopyRaw').addEventListener('click', async () => {
    try {
      await copyText(currentText());
      toast('已复制到剪贴板', 'success');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('#btnChatRaw').addEventListener('click', () => openInspector('对话请求 / 响应'));
  $('#btnSearchRaw').addEventListener('click', () => openInspector('搜索请求 / 响应'));
  $('#btnAgentRaw').addEventListener('click', () => openInspector('搜索增强请求 / 响应'));
  $('#btnFetchRaw').addEventListener('click', () => openInspector('网页抓取请求 / 响应'));
}
