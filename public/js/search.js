import { runChat, runFetch, runSearch } from './api.js';
import { renderMarkdown } from './markdown.js';
import { buildAgentMessages, buildChatPayload, buildSearchPayload, getChatAuth, getSearchAuth } from './payloads.js';
import { rememberExchange, state } from './state.js';
import { $, $$, escapeHtml, formatDate, formatDuration, hostOf, safeUrl, setButtonBusy, toast } from './utils.js';

function errorState(message, requestId = '') {
  return `
    <div class="empty-state">
      <div class="empty-mark">!</div>
      <h3>请求失败</h3>
      <p>${escapeHtml(message)}${requestId ? `<br><span class="muted">请求 ID: ${escapeHtml(requestId)}</span>` : ''}</p>
    </div>`;
}

function loadingState(label) {
  return `
    <div class="empty-state">
      <div class="typing-dots"><span></span><span></span><span></span></div>
      <h3>${escapeHtml(label)}</h3>
      <p>正在等待上游接口返回结果…</p>
    </div>`;
}

function metaChips(items) {
  return items
    .filter(Boolean)
    .map(([label, value]) => `<span class="meta-chip">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>`)
    .join('');
}

let lastSearchResults = [];
let searchView = 'tree';

function numericMetric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function resultDomain(result) {
  return String(result.site_name || hostOf(result.url) || '未知来源').trim() || '未知来源';
}

function clipText(value, maxLength = 150) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function domainMonogram(domain) {
  return [...String(domain || '?').replace(/^www\./i, '')].slice(0, 2).join('').toUpperCase() || '?';
}

function groupResultsByDomain(results) {
  const groups = new Map();
  results.forEach((result, index) => {
    const domain = resultDomain(result);
    if (!groups.has(domain)) {
      groups.set(domain, { domain, host: hostOf(result.url), items: [] });
    }
    groups.get(domain).items.push({ result, rank: index + 1 });
  });
  return [...groups.values()].sort((left, right) => {
    if (right.items.length !== left.items.length) return right.items.length - left.items.length;
    return Math.min(...left.items.map(({ rank }) => rank)) - Math.min(...right.items.map(({ rank }) => rank));
  });
}

function spaceTreeLeaf(item) {
  const { result, rank } = item;
  const url = safeUrl(result.url);
  const tag = url === '#' ? 'div' : 'a';
  const href = url === '#' ? '' : ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"`;
  const snippet = clipText(result.snippet || result.summary || result.url);
  const score = numericMetric(result.rerank_score);
  const authority = numericMetric(result.authority);
  const scoreClass = score !== null && score >= 1.5 ? ' high' : '';
  return `
    <${tag} class="space-leaf"${href}>
      <span class="space-leaf-rank">${rank}</span>
      <span class="space-leaf-copy">
        <span class="space-leaf-title">${escapeHtml(result.title || '未命名页面')}</span>
        ${snippet ? `<span class="space-leaf-snippet">${escapeHtml(snippet)}</span>` : ''}
      </span>
      <span class="space-leaf-meta">
        ${score !== null ? `<span class="leaf-score${scoreClass}">${score.toFixed(2)}</span>` : ''}
        ${authority !== null && authority >= 0 ? `<span class="leaf-authority">权 ${authority}</span>` : ''}
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>
      </span>
    </${tag}>`;
}

function spaceTreeDomain(group) {
  const scores = group.items.map(({ result }) => numericMetric(result.rerank_score)).filter((score) => score !== null);
  const averageScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  const detail = [group.host && group.host !== group.domain ? group.host : '', `${group.items.length} 个页面`].filter(Boolean).join(' · ');
  return `
    <details class="space-domain" open>
      <summary>
        <span class="domain-monogram" aria-hidden="true">${escapeHtml(domainMonogram(group.domain))}</span>
        <span class="domain-copy">
          <strong>${escapeHtml(group.domain)}</strong>
          <small>${escapeHtml(detail)}</small>
        </span>
        ${averageScore !== null ? `<span class="domain-score"><small>均分</small>${averageScore.toFixed(2)}</span>` : ''}
        <span class="domain-chevron" aria-hidden="true"></span>
      </summary>
      <div class="space-leaves">
        ${group.items.map(spaceTreeLeaf).join('')}
      </div>
    </details>`;
}

function renderSpaceTree(results, query) {
  const groups = groupResultsByDomain(results);
  const siteCount = new Set(groups.map((group) => group.host || group.domain)).size;
  $('#searchTreeQuery').textContent = query || '当前搜索';
  $('#searchTreeStats').innerHTML = `
    <span><strong>${results.length}</strong> 页面</span>
    <span><strong>${siteCount}</strong> 站点</span>`;
  $('#searchTreeDescription').textContent = `按 ${siteCount} 个站点聚合 ${results.length} 个页面，展开节点查看来源。`;
  $('#searchTreeBranches').innerHTML = groups.map(spaceTreeDomain).join('');
}

function prepareResultsView() {
  $('#searchViewBar').hidden = true;
  $('#searchTreeView').hidden = true;
  $('#searchResults').hidden = false;
}

function applySearchView() {
  if (!lastSearchResults.length) return;
  const treeVisible = searchView === 'tree';
  $('#searchTreeView').hidden = !treeVisible;
  $('#searchResults').hidden = treeVisible;
  $('#searchViewHint').textContent = treeVisible ? '按站点聚合来源关系' : '保留完整摘要与正文入口';
  $$('[data-search-view]').forEach((button) => {
    const active = button.dataset.searchView === searchView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function resultCard(result, index) {
  const url = safeUrl(result.url);
  const title = escapeHtml(result.title || '未命名页面');
  const titleHtml = url === '#'
    ? `<span>${title}</span>`
    : `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`;
  const score = Number(result.rerank_score);
  const authority = Number(result.authority);
  const content = String(result.content || '');
  const contentHtml = content
    ? `<details class="result-content"><summary>查看网页正文 · ${content.length.toLocaleString('zh-CN')} 字符</summary><div class="markdown-body">${renderMarkdown(content.slice(0, 24000))}</div></details>`
    : '';

  return `
    <article class="result-card">
      <div class="result-head">
        <div class="result-rank">${index + 1}</div>
        <div class="result-main">
          <h3 class="result-title">${titleHtml}</h3>
          <span class="result-url">${escapeHtml(result.url || '')}</span>
          ${result.snippet ? `<p class="result-snippet">${escapeHtml(result.snippet)}</p>` : ''}
          ${result.summary ? `<p class="result-summary">${escapeHtml(result.summary)}</p>` : ''}
          <div class="result-footer">
            ${result.site_name ? `<span class="result-badge">${escapeHtml(result.site_name)}</span>` : ''}
            ${result.date ? `<span>${escapeHtml(formatDate(result.date))}</span>` : ''}
            ${Number.isFinite(score) ? `<span class="result-badge ${score >= 1.5 ? 'score' : ''}">相关度 ${score.toFixed(2)}</span>` : ''}
            ${Number.isFinite(authority) && authority >= 0 ? `<span class="result-badge ${authority >= 3 ? 'authority' : ''}">权威度 ${authority}</span>` : ''}
          </div>
          ${contentHtml}
        </div>
      </div>
    </article>`;
}

function renderResults(results, query = '') {
  const container = $('#searchResults');
  lastSearchResults = results;
  prepareResultsView();
  if (!results.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-mark">∅</div>
        <h3>没有匹配结果</h3>
        <p>尝试缩短关键词、去掉限制性操作符，或换一种说法。</p>
      </div>`;
    return;
  }
  searchView = 'tree';
  renderSpaceTree(results, query);
  container.innerHTML = results.map(resultCard).join('');
  $('#searchViewBar').hidden = false;
  applySearchView();
}

function sourceCard(result, index) {
  const url = safeUrl(result.url);
  const tag = url === '#' ? 'div' : 'a';
  const href = url === '#' ? '' : ` href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"`;
  return `
    <${tag} class="source-card" id="source-${index + 1}"${href}>
      <span class="source-index">${index + 1}</span>
      <span class="source-body">
        <span class="source-title">${escapeHtml(result.title || '未命名页面')}</span>
        <span class="source-domain">${escapeHtml(result.site_name || hostOf(result.url) || result.url || '')}</span>
      </span>
    </${tag}>`;
}

function renderSources(results) {
  $('#sourceCount').textContent = `${results.length} 条`;
  $('#agentSources').innerHTML = results.map(sourceCard).join('');
}

async function handleSearch(event) {
  event.preventDefault();
  if (state.searchBusy) return;
  const query = $('#searchQuery').value.trim();
  let payload;
  let auth;
  try {
    payload = buildSearchPayload(query);
    auth = getSearchAuth();
  } catch (error) {
    toast(error.message, 'warning', 5000);
    return;
  }

  state.searchBusy = true;
  const button = $('#btnSearch');
  setButtonBusy(button, true, '搜索中');
  $('#searchEmpty').hidden = true;
  $('#searchMeta').hidden = true;
  prepareResultsView();
  $('#searchResults').innerHTML = loadingState('正在检索实时网页');
  rememberExchange({ endpoint: `${auth.baseUrl}/tools/search`, body: payload }, null);
  const startedAt = performance.now();

  try {
    const response = await runSearch({ baseUrl: auth.baseUrl, apiKey: auth.apiKey, payload });
    const elapsed = performance.now() - startedAt;
    $('#searchMeta').hidden = false;
    $('#searchMeta').innerHTML = metaChips([
      ['结果', `${response.results.length} 条`],
      ['耗时', formatDuration(elapsed)],
      ['count', String(payload.count)],
      ['正文', payload.need_content ? '已返回' : '未返回'],
    ]);
    renderResults(response.results, query);
    rememberExchange({ endpoint: `${auth.baseUrl}/tools/search`, body: payload }, response.raw);
  } catch (error) {
    prepareResultsView();
    $('#searchResults').innerHTML = errorState(error.message, error.requestId);
    rememberExchange(
      { endpoint: `${auth.baseUrl}/tools/search`, body: payload },
      error.payload || { error: { message: error.message } },
    );
    toast(error.message, 'error', 6500);
  } finally {
    state.searchBusy = false;
    setButtonBusy(button, false);
  }
}

async function handleAgent(event) {
  event.preventDefault();
  if (state.agentBusy) return;
  const question = $('#agentQuery').value.trim();
  let searchPayload;
  let searchAuth;
  let chatAuth;
  try {
    searchPayload = buildSearchPayload(question);
    searchAuth = getSearchAuth();
    chatAuth = getChatAuth();
  } catch (error) {
    toast(error.message, 'warning', 5000);
    return;
  }

  state.agentBusy = true;
  const button = $('#btnAgent');
  setButtonBusy(button, true, '检索中');
  $('#agentEmpty').hidden = true;
  $('#agentOutput').hidden = false;
  $('#agentAnswer').innerHTML = loadingState('正在检索相关网页');
  $('#agentAnswer').className = 'markdown-body';
  $('#agentReasoningBox').hidden = true;
  $('#agentMeta').textContent = 'Search API';
  $('#agentSources').innerHTML = '';
  $('#sourceCount').textContent = '';
  rememberExchange({ search: { endpoint: `${searchAuth.baseUrl}/tools/search`, body: searchPayload } }, null);

  const startedAt = performance.now();
  try {
    const searchResponse = await runSearch({ baseUrl: searchAuth.baseUrl, apiKey: searchAuth.apiKey, payload: searchPayload });
    if (!searchResponse.results.length) {
      $('#agentAnswer').innerHTML = '<div class="note note-warn">搜索没有返回结果，无法进行基于来源的回答。</div>';
      $('#agentMeta').textContent = '0 条来源';
      rememberExchange(
        { search: { endpoint: `${searchAuth.baseUrl}/tools/search`, body: searchPayload } },
        { search: searchResponse.raw, chat: null },
      );
      return;
    }

    renderSources(searchResponse.results);
    button.innerHTML = '<span class="spinner"></span><span>生成中</span>';
    $('#agentMeta').textContent = `${searchResponse.results.length} 条来源 · 生成中`;

    const chatMessages = buildAgentMessages(question, searchResponse.results);
    const chatPayload = buildChatPayload(chatMessages);
    const requestRecord = {
      search: { endpoint: `${searchAuth.baseUrl}/tools/search`, body: searchPayload },
      chat: { endpoint: `${chatAuth.baseUrl}/chat/completions`, body: chatPayload },
    };
    rememberExchange(requestRecord, null);

    let content = '';
    let reasoning = '';
    let usage = null;
    const chatResult = await runChat({
      baseUrl: chatAuth.baseUrl,
      apiKey: chatAuth.apiKey,
      payload: chatPayload,
      onDelta: (delta) => {
        content = delta.fullContent;
        reasoning = delta.fullReasoning;
        $('#agentAnswer').innerHTML = content ? renderMarkdown(content) : '<div class="typing-dots"><span></span><span></span><span></span></div>';
        if (reasoning) {
          $('#agentReasoning').textContent = reasoning;
          $('#agentReasoningBox').hidden = false;
          $('#agentReasoningBox').open = true;
        }
      },
    });
    content = chatResult.content || content;
    reasoning = chatResult.reasoning || reasoning;
    usage = chatResult.usage;
    $('#agentAnswer').innerHTML = content
      ? renderMarkdown(content)
      : '<p class="muted">模型没有返回文本内容。</p>';
    $('#agentReasoningBox').hidden = !reasoning;
    $('#agentReasoning').textContent = reasoning;
    const totalElapsed = performance.now() - startedAt;
    $('#agentMeta').textContent = [
      `${searchResponse.results.length} 条来源`,
      formatDuration(totalElapsed),
      usage?.total_tokens ? `${usage.total_tokens} tokens` : '',
    ].filter(Boolean).join(' · ');
    rememberExchange(requestRecord, { search: searchResponse.raw, chat: chatResult.raw });
  } catch (error) {
    $('#agentAnswer').innerHTML = `<div class="note note-warn">${escapeHtml(error.message)}${error.requestId ? `<br>请求 ID: ${escapeHtml(error.requestId)}` : ''}</div>`;
    $('#agentMeta').textContent = '请求失败';
    toast(error.message, 'error', 6500);
  } finally {
    state.agentBusy = false;
    setButtonBusy(button, false);
  }
}

async function handleFetch(event) {
  event.preventDefault();
  if (state.fetchBusy) return;
  const url = $('#fetchUrl').value.trim();
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 http/https URL');
  } catch {
    toast('请输入合法的 http(s) URL', 'warning');
    return;
  }
  let auth;
  try {
    auth = getSearchAuth();
  } catch (error) {
    toast(error.message, 'warning');
    return;
  }

  state.fetchBusy = true;
  const button = $('#btnFetch');
  setButtonBusy(button, true, '抓取中');
  $('#fetchEmpty').hidden = true;
  $('#fetchResult').hidden = false;
  $('#fetchTitle').textContent = '正在抓取…';
  $('#fetchContent').innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  $('#fetchOpenLink').href = parsed.href;
  rememberExchange({ endpoint: `${auth.baseUrl}/tools/fetch`, body: { url: parsed.href } }, null);

  try {
    const response = await runFetch({
      baseUrl: auth.baseUrl,
      apiKey: auth.apiKey,
      payload: { url: parsed.href },
    });
    $('#fetchTitle').textContent = response.title || hostOf(parsed.href) || '网页正文';
    $('#fetchContent').innerHTML = response.content
      ? renderMarkdown(response.content)
      : '<div class="note">页面没有可提取的正文内容。</div>';
    rememberExchange({ endpoint: `${auth.baseUrl}/tools/fetch`, body: { url: parsed.href } }, response.raw);
  } catch (error) {
    $('#fetchTitle').textContent = '抓取失败';
    $('#fetchContent').innerHTML = `<div class="note note-warn">${escapeHtml(error.message)}</div>`;
    rememberExchange(
      { endpoint: `${auth.baseUrl}/tools/fetch`, body: { url: parsed.href } },
      error.payload || { error: { message: error.message } },
    );
    toast(error.message, 'error', 6500);
  } finally {
    state.fetchBusy = false;
    setButtonBusy(button, false);
  }
}

function updateHints() {
  $('#searchConfigHint').textContent = `将返回 ${state.config.searchCount || 10} 条结果 · 正文${state.config.needContent ? '开启' : '关闭'}`;
  $('#agentConfigHint').textContent = `检索 ${state.config.searchCount || 10} 条后由 ${state.config.model || '当前模型'} 回答`;
}

export function initSearch() {
  updateHints();
  $('#searchForm').addEventListener('submit', handleSearch);
  $$('[data-search-view]').forEach((button) => {
    button.addEventListener('click', () => {
      searchView = button.dataset.searchView;
      applySearchView();
    });
  });
  $('#btnExpandDomains').addEventListener('click', () => {
    $$('#searchTreeBranches details').forEach((details) => { details.open = true; });
  });
  $('#btnCollapseDomains').addEventListener('click', () => {
    $$('#searchTreeBranches details').forEach((details) => { details.open = false; });
  });
  $('#agentForm').addEventListener('submit', handleAgent);
  $('#fetchForm').addEventListener('submit', handleFetch);

  $('#searchQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('#searchForm').requestSubmit();
    }
  });
  $('#agentQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      $('#agentForm').requestSubmit();
    }
  });

  document.querySelectorAll('[data-example]').forEach((button) => {
    button.addEventListener('click', () => {
      $('#searchQuery').value = button.dataset.example;
      $('#searchQuery').focus();
    });
  });

  document.addEventListener('config-changed', updateHints);
}

export function resetSearch() {
  lastSearchResults = [];
  searchView = 'tree';
  prepareResultsView();
  $('#searchResults').innerHTML = '';
  $('#searchTreeBranches').innerHTML = '';
  $('#searchMeta').hidden = true;
  $('#searchEmpty').hidden = false;
}

export function resetAgent() {
  $('#agentOutput').hidden = true;
  $('#agentEmpty').hidden = false;
  $('#agentAnswer').innerHTML = '';
  $('#agentSources').innerHTML = '';
  $('#agentReasoningBox').hidden = true;
}

export function resetFetch() {
  $('#fetchResult').hidden = true;
  $('#fetchEmpty').hidden = false;
  $('#fetchTitle').textContent = '未命名页面';
  $('#fetchContent').innerHTML = '';
}
