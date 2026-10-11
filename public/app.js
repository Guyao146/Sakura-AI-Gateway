const state = {
  config: null,
  metrics: null,
  health: null,
  balances: null,
  catalog: null,
  adminAuth: null,
  expandedPrefixes: new Set(),
 integrations: null,
  modelSelectionDraft: null,
  logPage: null,
  loadingMoreLogs: false,
  metricsRefreshInFlight: false,
metricsRefreshTimer: null,
// 时间范围统计：{ from, to, data }；为 null 时展示全部统计。
metricsRange: null
};
state.activeTab = 'overview';
const $ = (selector) => document.querySelector(selector);
const { groupModelsByPrefix, mergeModelsById, modelGroupKey, modelPrefix, pooledUpstreamIds, setUnifiedModelsSelected, unifiedModelSelectionKey } = window.ModelGroups;
const { normalizeKeyAccess, keyAccessModels } = window.KeyAccess;
const { renderReleaseNotes } = window.ReleaseNotes;
const PANEL_ORDER_KEY = 'sakura-ai-gateway.panel-order.v1';
const ACTIVE_TAB_KEY = 'sakura-ai-gateway.active-tab.v2';

// 仅在新键尚不存在时复制旧版偏好；保留旧值，存储不可用也不阻止页面加载。
function migrateBrowserPreferences() {
  try {
    for (const suffix of ['panel-order.v1', 'active-tab.v2', 'card-order.v1']) {
      const key = `sakura-ai-gateway.${suffix}`;
      const previous = localStorage.getItem(`local-model-gateway.${suffix}`);
      if (localStorage.getItem(key) === null && previous !== null) localStorage.setItem(key, previous);
    }
  } catch { /* Browser preferences are optional. */ }
}
migrateBrowserPreferences();

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

// 上游卡片上的模型列表去重：大小写不同算同一个模型，保留先出现的「当前名称」。
function uniqueModelLabels(models) {
  const seen = new Set();
  const labels = [];
  for (const id of Array.isArray(models) ? models : []) {
    const key = String(id || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    labels.push(String(id));
  }
  return labels;
}

function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...adminHeaders(), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && body.error?.loginUrl) window.location.assign(body.error.loginUrl);
    const requestId = response.headers.get('x-request-id');
    const error = new Error(body.error?.message || `请求失败（${response.status}）`);
    console.error('[Sakura-AI-Gateway] 请求失败', { requestId, status: response.status, response: body });
    error.requestId = requestId;
    throw error;
  }
  return body;
}

function setMessage(message, type = '') {
  const element = $('#authMessage');
  element.textContent = message;
  element.className = `form-message ${type}`;
}

function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 3600);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function switchTab(tab) {
  const target = String(tab || 'overview');
  state.activeTab = target;
  for (const page of document.querySelectorAll('[data-tab-page]')) {
    page.classList.toggle('hidden', page.dataset.tabPage !== target);
  }
  for (const button of document.querySelectorAll('.tab')) {
    const selected = button.dataset.tab === target;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
  }
  try { localStorage.setItem(ACTIVE_TAB_KEY, target); } catch { /* persistence is best-effort */ }
  // 切到请求日志页时主动拉取最新日志；5 秒自动刷新使用 preserveLogs，不会更新该表格。
  // 仅在面板已解锁时加载，避免页面初始恢复标签时触发未认证请求。
  if (target === 'logs' && !$('#dashboard').classList.contains('hidden') && typeof refreshRequestLogs === 'function') {
    refreshRequestLogs();
  }
  if (target === 'keys' && !$('#dashboard').classList.contains('hidden') && typeof loadIntegrations === 'function') {
    loadIntegrations();
  }
}

function restoreActiveTab() {
  let saved = '';
  try { saved = localStorage.getItem(ACTIVE_TAB_KEY) || ''; } catch { saved = ''; }
  switchTab(saved && document.querySelector(`[data-tab-page="${saved}"]`) ? saved : 'overview');
}

function enablePanelDragging() {
  const dashboard = $('#dashboard');
  if (!dashboard || dashboard.dataset.panelDragBound === 'true') return;
  dashboard.dataset.panelDragBound = 'true';
  const panels = [...dashboard.querySelectorAll(':scope > [data-panel-id]')];
  let savedOrder = [];
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_ORDER_KEY) || '[]');
    savedOrder = Array.isArray(saved) ? saved : [];
  } catch { savedOrder = []; }
  const byId = new Map(panels.map((panel) => [panel.dataset.panelId, panel]));
  for (const id of savedOrder) if (byId.has(id)) dashboard.appendChild(byId.get(id));
  for (const panel of panels) if (!savedOrder.includes(panel.dataset.panelId)) dashboard.appendChild(panel);
  for (const panel of panels) {
    panel.draggable = true;
    const heading = panel.querySelector(':scope > .panel-heading > div');
    if (heading && !heading.querySelector('[data-panel-drag-handle]')) {
      heading.insertAdjacentHTML('afterbegin', '<button type="button" class="panel-drag-handle" data-panel-drag-handle aria-label="拖动调整功能卡片位置" title="拖动排序">⋮⋮</button>');
    }
  }
  dashboard.addEventListener('dragstart', (event) => {
    const panel = event.target.closest('[data-panel-drag-handle]')?.closest('[data-panel-id]');
    if (!panel || panel.parentElement !== dashboard) {
      if (event.target.closest('[data-panel-id]')?.parentElement === dashboard) event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', panel.dataset.panelId);
    panel.classList.add('panel-dragging');
  });
  dashboard.addEventListener('dragover', (event) => {
    const dragging = dashboard.querySelector(':scope > .panel-dragging');
    const target = event.target.closest('[data-panel-id]');
    if (!dragging || !target || target.parentElement !== dashboard || dragging === target) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    dashboard.insertBefore(dragging, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
  });
  dashboard.addEventListener('drop', (event) => {
    if (!dashboard.querySelector(':scope > .panel-dragging')) return;
    event.preventDefault();
    const order = [...dashboard.querySelectorAll(':scope > [data-panel-id]')].map((panel) => panel.dataset.panelId);
    try { localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(order)); } catch { /* sorting remains active until reload */ }
  });
  dashboard.addEventListener('dragend', () => dashboard.querySelector(':scope > .panel-dragging')?.classList.remove('panel-dragging'));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
}

function renderUpdateStatus(result) {
  const current = result?.currentVersion || state.config?.appVersion || '-';
  $('#currentVersion').textContent = current;
  const message = $('#updateMessage');
  const details = $('#updateDetails');
  if (!result) {
    message.textContent = '尚未检查';
    message.className = 'muted';
    details.classList.add('hidden');
    $('#releaseNotesList')?.classList.add('hidden');
    return;
  }
  message.textContent = result.updateAvailable ? `发现新版本：${result.latest.version}` : `已是最新版本（检查于 ${formatTime(result.checkedAt)}）`;
  message.className = result.updateAvailable ? 'success-text' : 'muted';
  if (result.updateAvailable) {
    details.innerHTML = `<strong>${escapeHtml(result.latest.name)}</strong><span>发布时间：${escapeHtml(formatTime(result.latest.publishedAt))}</span><div class="update-actions"><a class="button secondary" href="${escapeHtml(result.latest.url)}" target="_blank" rel="noopener noreferrer">打开 GitHub Release</a></div>`;
    details.classList.remove('hidden');
  } else details.classList.add('hidden');
  renderReleaseList(result);
}

// 更新日志列表：每个稳定版一条，最新版在顶部并带版本徽章与自动升级按钮。
function renderReleaseList(result) {
  const container = $('#releaseNotesList');
  if (!container) return;
  const releases = Array.isArray(result?.releases) ? result.releases : [];
  if (!releases.length) { container.classList.add('hidden'); container.innerHTML = ''; return; }
  const latestVersion = result.latest?.version || '';
  const canUpgrade = Boolean(result.updateAvailable && result.upgradeAsset);
  const items = releases.map((release) => {
    const badge = release.isCurrent
      ? '<span class="version-badge current">当前版本</span>'
      : (release.version === latestVersion ? '<span class="version-badge latest">新版本</span>' : '');
    const upgradeButton = canUpgrade && release.version === latestVersion
      ? '<button type="button" id="autoUpdateButton" class="button primary">自动升级</button>' : '';
    const assets = release.assets.map((asset) => `<a class="button secondary" href="${escapeHtml(asset.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(asset.name)}</a>`).join('');
    return `<article class="release-note">
      <header class="release-note-header"><code class="release-version">v${escapeHtml(release.version)}</code>${badge}<span class="release-name">${escapeHtml(release.name)}</span><span class="release-date muted">${escapeHtml(formatTime(release.publishedAt))}</span></header>
      <div class="markdown-body">${renderReleaseNotes(release.body) || '<p class="muted">该版本没有发布说明。</p>'}</div>
      ${upgradeButton || assets ? `<div class="update-actions">${upgradeButton}${assets}</div>` : ''}
    </article>`;
  });
  container.innerHTML = items.join('');
  container.classList.remove('hidden');
  $('#autoUpdateButton')?.addEventListener('click', startAutoUpdate);
}

async function startAutoUpdate() {
  if (!window.confirm(`确认升级到 ${state.update?.latest?.version || '新版本'} 吗？服务会短暂重启，data 配置会保留。`)) return;
  const button = $('#autoUpdateButton');
  if (button) { button.disabled = true; button.textContent = '升级中…'; }
  try {
    const result = await api('/api/admin/update', { method: 'POST', body: '{}' });
    toast(result.message || '正在升级，服务即将重启');
    $('#updateMessage').textContent = result.message || '正在升级…';
  } catch (error) {
    toast(error.message, 'error');
    if (button) { button.disabled = false; button.textContent = '自动升级'; }
  }
}

async function checkForUpdates() {
  const button = $('#checkUpdateButton');
  button.disabled = true;
  button.textContent = '检查中…';
  try {
    const result = await api('/api/admin/update-check');
    state.update = result;
    renderUpdateStatus(result);
    toast(result.updateAvailable ? `发现新版本 ${result.latest.version}` : '当前已是最新版本');
    return result;
  } catch (error) {
    $('#updateMessage').textContent = error.message;
    $('#updateMessage').className = 'error-text';
    toast(error.message, 'error');
    return null;
  } finally { button.disabled = false; button.textContent = '检查更新'; }
}

// 更新日志：10 分钟内的检查结果直接展示，否则重新拉取。
async function viewChangelog() {
  const button = $('#viewChangelogButton');
  if (!button) return;
  button.disabled = true;
  button.textContent = '加载中…';
  try {
    const checkedAt = state.update?.checkedAt ? Date.parse(state.update.checkedAt) : 0;
    const fresh = checkedAt && (Date.now() - checkedAt) < 10 * 60 * 1000 && Array.isArray(state.update.releases);
    if (!fresh) await checkForUpdates();
    else {
      renderUpdateStatus(state.update);
      toast('展示最近版本的更新日志');
    }
    const first = $('#releaseNotesList .release-note');
    if (first) first.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    toast(error.message, 'error');
  } finally { button.disabled = false; button.textContent = '更新日志'; }
}

const CARD_ORDER_KEY = 'sakura-ai-gateway.card-order.v1';

function cardOrder(type) {
  try {
    const saved = JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || '{}');
    return Array.isArray(saved[type]) ? saved[type] : [];
  } catch { return []; }
}

function orderedItems(type, items) {
  const order = cardOrder(type);
  const position = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((left, right) => {
    const a = position.has(left.id) ? position.get(left.id) : Number.MAX_SAFE_INTEGER;
    const b = position.has(right.id) ? position.get(right.id) : Number.MAX_SAFE_INTEGER;
    return a - b;
  });
}

function saveCardOrder(type, container) {
  const ids = [...container.querySelectorAll('[data-card-id]')].map((item) => item.dataset.cardId).filter(Boolean);
  try {
    const saved = JSON.parse(localStorage.getItem(CARD_ORDER_KEY) || '{}');
    saved[type] = ids;
    localStorage.setItem(CARD_ORDER_KEY, JSON.stringify(saved));
  } catch { /* private browsing/localStorage disabled: sorting still works until reload */ }
}

function enableCardDragging(type, container) {
  if (!container || container.dataset.dragBound === 'true') return;
  container.dataset.dragBound = 'true';
  container.addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-card-id]');
    if (!card) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.cardId);
    card.classList.add('dragging');
  });
  container.addEventListener('dragend', (event) => event.target.closest('[data-card-id]')?.classList.remove('dragging'));
  container.addEventListener('dragover', (event) => {
    const dragging = container.querySelector('.dragging');
    const target = event.target.closest('[data-card-id]');
    if (!dragging || !target || dragging === target) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    container.insertBefore(dragging, event.clientY < rect.top + rect.height / 2 ? target : target.nextSibling);
  });
  container.addEventListener('drop', (event) => {
    if (container.querySelector('.dragging')) { event.preventDefault(); saveCardOrder(type, container); }
  });
}

function healthLabel(item) {
  if (!item) return '健康';
  if (item.state === 'open') return '已熔断';
  if (item.state === 'half-open') return '半开探测';
  return '健康';
}

function clientIdentityLabel(item) {
  return {
    default: '默认客户端',
    claude_code: 'Claude Code',
    codex_cli: 'Codex CLI',
    cherry_studio: 'Cherry Studio',
    custom: item?.customUserAgent || '自定义客户端'
  }[item?.clientIdentityPreset || 'default'] || '默认客户端';
}

function formatBalanceNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '-';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function balanceDetails(item) {
  if (!item || item.state === 'idle') return '<span class="balance-status muted">余额：尚未查询</span>';
  if (item.state !== 'ok' || !item.balance) {
    const label = item.state === 'unsupported' ? '不支持余额查询' : '余额查询失败';
    const status = item.httpStatus ? `（HTTP ${item.httpStatus}）` : '';
    return `<span class="balance-status error-text">余额：${label}${escapeHtml(status)}</span><span class="balance-error-message" title="${escapeHtml(item.message || label)}">${escapeHtml(item.message || label)}</span>${item.checkedAt ? `<span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>` : ''}`;
  }
  if (item.balance.type === 'platform-quotas') {
    const windows = (item.balance.platforms || []).flatMap((platform) => (platform.windows || []).map((window) => {
      const limit = window.limit === null ? '未设上限' : `$${formatBalanceNumber(window.limit)}`;
      const remaining = window.remaining === null ? '' : ` · 剩余 $${formatBalanceNumber(window.remaining)}`;
      const reset = window.resetAt ? ` · ${formatTime(window.resetAt)} 重置` : '';
      return `${platform.platform} ${window.period}：已用 $${formatBalanceNumber(window.used)} / ${limit}${remaining}${reset}`;
    }));
    return `<span class="balance-status success-text">额度：${escapeHtml(windows.join('；') || '未设置平台额度')}</span><span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>`;
  }
  const balance = item.balance;
  const unit = balance.unit ? ` ${balance.unit}` : '';
  const remaining = balance.unlimited ? '无限' : `${formatBalanceNumber(balance.remaining)}${unit}`;
  const parts = [`剩余：${remaining}`];
  if (balance.used !== null) parts.push(`已用：${formatBalanceNumber(balance.used)}${unit}`);
  if (balance.granted !== null) parts.push(`总额度：${formatBalanceNumber(balance.granted)}${unit}`);
  if (balance.expiresAt) parts.push(`到期：${formatTime(balance.expiresAt)}`);
  return `<span class="balance-status success-text">${escapeHtml(parts.join(' · '))}</span><span>查询于：${escapeHtml(formatTime(item.checkedAt))}</span>`;
}

function thinkingLabel(level) {
  return { auto: '自动', client: '遵循客户端', off: '关闭', none: '无（none）', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高' }[level] || level;
}

const THINKING_GRADES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const THINKING_SOURCE_LABELS = { metadata: '上游声明', probe: '主动探测', inferred: '模型名推断', unknown: '能力未知' };

// 同一个模型 ID 可能来自多个站点：思考档位取并集，信息来源取可信度最高的一档。
function mergedThinkingCapability(model) {
  const levels = [];
  let source = 'unknown';
  for (const provider of model.providers || []) {
    const info = provider.model || {};
    const providerSource = info.thinkingSource || 'unknown';
    for (const level of THINKING_GRADES) {
      if (Array.isArray(info.thinkingLevels) && info.thinkingLevels.includes(level) && !levels.includes(level)) levels.push(level);
    }
    const rank = { probe: 2, metadata: 3, inferred: 1, unknown: 0 };
    if (rank[providerSource] > rank[source]) source = providerSource;
  }
  return { levels, source };
}

function thinkingMarkup(model, capability) {
  const origin = `${THINKING_SOURCE_LABELS[capability.source] || '能力未知'}：${capability.levels.length ? capability.levels.map((level) => thinkingLabel(level)).join(' / ') : '未探测到可用档位'}`;
  const probeTag = capability.source === 'probe' ? '<span class="thinking-probe-tag" title="已通过探测请求确认">探测</span>' : '';
  if (model.supportsThinking === true) {
    return `<span class="thinking-badge" title="思考能力来源 — ${escapeHtml(origin)}">支持思考</span>${probeTag}`;
  }
  if (model.supportsThinking === null) return '<span class="thinking-badge thinking-unknown" title="上游未声明也无法推断；可点「拉取思考强度」探测">能力未知</span>';
  return `<span class="thinking-badge thinking-disabled" title="上游不支持思考 — ${escapeHtml(origin)}">不支持思考</span>${probeTag}`;
}

// 思考强度下拉只列出上游探测到的档位；已保存但上游未探测到的档位仍然保留，
// 只是加上标注，避免静默改写用户此前的选择。
function thinkingLevelOptions(levels, selected) {
  const available = new Set(levels.length ? levels : ['low', 'medium', 'high']);
  const fixed = [['client', '遵循客户端'], ['auto', '自动'], ['off', '关闭（不发送）']]
    .map(([value, label]) => `<option value="${value}"${selected === value ? ' selected' : ''}>思考：${label}</option>`)
    .join('');
  const graded = THINKING_GRADES
    .filter((level) => available.has(level) || selected === level)
    .map((level) => `<option value="${level}"${selected === level ? ' selected' : ''}>思考：${thinkingLabel(level)}${available.has(level) ? '' : '（上游未探测到）'}</option>`)
    .join('');
  return fixed + graded;
}

function catalogSelectionMap() {
  if (!(state.modelSelectionDraft instanceof Map)) {
    state.modelSelectionDraft = new Map();
    for (const item of state.catalog?.selections || []) {
      const key = unifiedModelSelectionKey(item.upstreamModel);
      if (!key) continue;
      const previous = state.modelSelectionDraft.get(key);
      const itemIds = Array.isArray(item.upstreamIds) && item.upstreamIds.length ? item.upstreamIds : [item.upstreamId];
      if (previous) {
        const upstreamIds = [...new Set([...(previous.upstreamIds || [previous.upstreamId]), ...itemIds].filter(Boolean))];
        state.modelSelectionDraft.set(key, {
          ...previous,
          upstreamId: upstreamIds[0],
          upstreamIds,
          upstreamMode: upstreamIds.length > 1 ? 'auto' : previous.upstreamMode
        });
        continue;
      }
      state.modelSelectionDraft.set(key, {
        ...item,
        upstreamMode: item.upstreamMode === 'auto' ? 'auto' : 'fixed',
        upstreamIds: itemIds
      });
    }
  }
  return state.modelSelectionDraft;
}

const MODALITY_LABELS = { text: '文本', image: '图片', audio: '音频', video: '视频', file: '文件' };
function modalityLabelList(items) {
  return Array.isArray(items) ? (items.map((item) => MODALITY_LABELS[item] || item).join(' / ') || '无') : '未知';
}

function modalityMarkup(model) {
  return (model.providers || []).map((provider) => {
    const info = provider.model || {};
    const partial = !Array.isArray(info.inputModalities) ? Object.entries(info.inputModalitySupport || {})
      .map(([name, supported]) => `${MODALITY_LABELS[name] || name}${supported ? '支持' : '不支持'}`).join('、') : '';
    return `<div class="model-modalities">${escapeHtml(provider.name)} · 输入：${escapeHtml(modalityLabelList(info.inputModalities))}${partial ? `（${escapeHtml(partial)}）` : ''} · 输出：${escapeHtml(modalityLabelList(info.outputModalities))} · ${info.modalitySource === 'metadata' ? '上游声明' : '未声明'}</div>`;
  }).join('');
}

function translatorOptions(selected = '', localModel = '') {
  const candidates = new Map(keyAccessModels(state.config || {}).map((item) => [item.id, item.id]));
  for (const item of catalogSelectionMap().values()) candidates.set(item.localModel, item.localModel);
  if (selected && !candidates.has(selected)) candidates.set(selected, `${selected}（不可用，请重新选择）`);
  return `<option value="">转译：不启用</option>` + [...candidates].filter(([id]) => id.toLowerCase() !== localModel.toLowerCase())
    .map(([id, label]) => `<option value="${escapeHtml(id)}"${id === selected ? ' selected' : ''}>转译：${escapeHtml(label)}</option>`).join('');
}

async function refreshModelCapabilities(button) {
  syncRenderedModelDraft();
  const model = allUnifiedModels().find((item) => unifiedModelSelectionKey(item.id) === button.dataset.modelKey);
  if (!model) return;
  button.disabled = true;
  button.textContent = '拉取中…';
  let failures = 0;
  try {
    for (const provider of model.providers.filter((item) => item.enabled)) {
      const result = await api('/api/admin/model-catalog/capabilities', { method: 'POST', body: JSON.stringify({ upstreamId: provider.id, modelId: provider.model.id, probeThinking: true }) });
      state.catalog = result.catalog;
      if (result.syncError || result.probe?.failed || result.probe?.status === 'busy') failures += 1;
    }
    reconcileModelSelectionDraft(state.catalog);
    toast(failures ? `能力刷新完成，${failures} 个来源未能完整刷新，保留已有结论` : '能力已刷新；上游未声明的模态仍显示未知', failures ? 'error' : '');
  } catch (error) { toast(error.message, 'error'); }
  finally { renderModelCatalog(); }
}

function reconcileModelSelectionDraft(catalog, reset = false) {
  if (reset) state.modelSelectionDraft = null;
  const selections = new Map(catalogSelectionMap());
  const models = mergeModelsById(catalog?.upstreams || []);
  // 合并与选择都按大小写不敏感的键走：中转站换了拼写也不丢已保存的选择。
  const modelsById = new Map(models.map((model) => [unifiedModelSelectionKey(model.id), model]));
  const reconciled = new Map();
  for (const [key, selection] of selections) {
    const model = modelsById.get(key);
    if (!model) continue;
    const providerIds = model.providers.map((provider) => provider.id);
    if (selection.upstreamMode === 'auto' && providerIds.length > 1) {
      // Keep the saved round-robin pool; only drop stations that no longer offer the model.
      const pooledIds = pooledUpstreamIds(selection, providerIds);
      reconciled.set(key, { ...selection, upstreamId: pooledIds[0], upstreamIds: pooledIds, upstreamMode: 'auto' });
    } else if (providerIds.includes(selection.upstreamId)) {
      reconciled.set(key, { ...selection, upstreamIds: [selection.upstreamId], upstreamMode: 'fixed' });
    }
  }
  state.modelSelectionDraft = reconciled;
}

function syncRenderedModelDraft() {
  const draft = catalogSelectionMap();
  for (const row of document.querySelectorAll('.model-row')) {
    const checkbox = row.querySelector('[data-action="toggle-model"]');
    if (!checkbox) continue;
    const modelId = checkbox.dataset.modelId;
    const key = unifiedModelSelectionKey(modelId);
    if (!checkbox.checked) {
      draft.delete(key);
      continue;
    }
    const previous = draft.get(key) || {};
    const upstreamSelect = row.querySelector('[data-action="model-upstream"]');
    const providerIds = [...upstreamSelect.options].map((option) => option.value).filter((value) => value !== '__auto__');
    const automatic = upstreamSelect.value === '__auto__' && providerIds.length > 1;
    let pooledIds = providerIds;
    if (automatic) {
      const checked = [...row.querySelectorAll('[data-action="pool-provider"]')].filter((box) => box.checked).map((box) => box.dataset.providerId);
      // Keep at least two stations in the pool; fall back to all when the user unchecked too many.
      pooledIds = checked.length >= 2 ? providerIds.filter((id) => checked.includes(id)) : providerIds;
      const priorityInputs = [...row.querySelectorAll('[data-action="provider-priority"]')];
      if (priorityInputs.length) {
        const priorities = new Map(priorityInputs.map((input) => [input.dataset.providerId, Number(input.value) || 999]));
        pooledIds.sort((left, right) => (priorities.get(left) || 999) - (priorities.get(right) || 999));
      }
    }
    const upstreamId = automatic ? pooledIds[0] : upstreamSelect.value;
    draft.set(key, {
      ...previous,
      upstreamId,
      upstreamIds: automatic ? pooledIds : [upstreamId],
      upstreamMode: automatic ? 'auto' : 'fixed',
      upstreamModel: modelId,
      localModel: row.querySelector('[data-action="model-alias"]')?.value.trim() || modelId,
      thinkingLevel: row.querySelector('[data-action="thinking-level"]')?.value || 'auto',
      modalityTranslator: row.querySelector('[data-action="modality-translator"]')?.value || '',
      responsesMode: row.querySelector('[data-action="responses-mode"]')?.value || 'auto',
      enabled: true
    });
  }
}

function allUnifiedModels() {
  return mergeModelsById(state.catalog?.upstreams || []);
}

function filteredUnifiedModels(models) {
  const search = $('#modelCatalogSearch')?.value.trim().toLowerCase() || '';
  const thinkingOnly = Boolean($('#showThinkingModelsOnly')?.checked);
  return models.filter((model) => {
    const providerNames = model.providers.map((provider) => provider.name).join(' ');
    const matchesSearch = !search || `${providerNames} ${model.id} ${model.name} ${modelPrefix(model.id)}`.toLowerCase().includes(search);
    return matchesSearch && (!thinkingOnly || model.supportsThinking === true);
  });
}

function renderModelRow(model, selections) {
  const key = unifiedModelSelectionKey(model.id);
  const selection = selections.get(key);
  const selectedProvider = selection?.upstreamMode === 'auto' && model.providers.length > 1 ? '__auto__' : (selection?.upstreamId || (model.providers.length > 1 ? '__auto__' : model.providers[0]?.id));
  const providerOptions = `${model.providers.length > 1 ? `<option value="__auto__" ${selectedProvider === '__auto__' ? 'selected' : ''}>自动选择（${model.providers.length} 个站）</option>` : ''}${model.providers.map((provider) => `<option value="${escapeHtml(provider.id)}" ${selectedProvider === provider.id ? 'selected' : ''}>${escapeHtml(provider.name)} · ${escapeHtml(provider.protocol)}${provider.enabled ? '' : '（已停用）'}</option>`).join('')}`;
  const providerNames = model.providers.map((provider) => provider.name).join('、');
  const isAuto = selectedProvider === '__auto__';
  const providerIds = model.providers.map((provider) => provider.id);
  const pooledIds = new Set(isAuto ? pooledUpstreamIds(selection, providerIds) : []);
  const thinkingCapability = mergedThinkingCapability(model);
  const thinkingValue = selection?.thinkingLevel || 'auto';
  const poolMarkup = model.providers.length > 1
    ? `<div class="model-pool${isAuto ? '' : ' hidden'}" data-role="model-pool"><span class="model-pool-label">站点优先级：</span>${model.providers.map((provider) => { const priority = Math.max(1, (selection?.upstreamIds || providerIds).indexOf(provider.id) + 1); return `<label class="model-pool-item${provider.enabled ? '' : ' disabled'}"><input type="checkbox" data-action="pool-provider" data-provider-id="${escapeHtml(provider.id)}" ${pooledIds.has(provider.id) ? 'checked' : ''}><span>${escapeHtml(provider.name)}${provider.enabled ? '' : '（已停用）'}</span><input class="priority-input" type="number" min="1" max="99" value="${priority}" data-action="provider-priority" data-provider-id="${escapeHtml(provider.id)}" aria-label="${escapeHtml(provider.name)} 的使用优先级"></label>`; }).join('')}</div>`
    : '';
  return `<div class="model-row" data-model-key="${escapeHtml(key)}"><input type="checkbox" data-action="toggle-model" data-model-id="${escapeHtml(model.id)}" ${selection ? 'checked' : ''}><div><div class="model-name" title="${escapeHtml(model.id)}">${escapeHtml(model.id)}${model.providers.length > 1 ? `<span class="source-count-badge">${model.providers.length} 个站</span>` : ''}${thinkingMarkup(model, thinkingCapability)}</div><div class="model-info" title="${escapeHtml(providerNames)}">来源：${escapeHtml(providerNames)}</div>${modalityMarkup(model)}</div><div class="model-controls"><select data-action="model-upstream" aria-label="${escapeHtml(model.id)} 的上游站点">${providerOptions}</select><input type="text" data-action="model-alias" value="${escapeHtml(selection?.localModel || model.id)}" placeholder="本地模型别名"><select data-action="thinking-level">${thinkingLevelOptions(thinkingCapability.levels, thinkingValue)}</select><select data-action="responses-mode" aria-label="${escapeHtml(model.id)} 的接口协议"><option value="auto" ${!selection || selection.responsesMode === 'auto' ? 'selected' : ''}>协议：自动</option><option value="native" ${selection?.responsesMode === 'native' ? 'selected' : ''}>协议：Responses</option><option value="chat" ${selection?.responsesMode === 'chat' ? 'selected' : ''}>协议：Chat</option></select><select data-action="modality-translator" aria-label="${escapeHtml(model.id)} 的模态转译模型">${translatorOptions(selection?.modalityTranslator, selection?.localModel || model.id)}</select><button type="button" class="text-button" data-action="refresh-capabilities" data-model-key="${escapeHtml(key)}" title="刷新各来源的模态声明和思考档位；档位未声明时发送少量付费探测请求">拉取能力</button></div>${poolMarkup}</div>`;
}

function renderPrefixGroup(prefix, visibleModels, allModels, selections) {
  const prefixKey = modelGroupKey('unified', prefix);
  const completeModels = allModels.filter((model) => modelPrefix(model.id) === prefix);
  const selectedCount = completeModels.filter((model) => selections.has(unifiedModelSelectionKey(model.id))).length;
  const collapsed = state.expandedPrefixes.has(prefixKey) ? '' : ' collapsed';
  return `<section class="model-prefix${collapsed}" data-prefix-key="${escapeHtml(prefixKey)}"><div class="model-prefix-header"><button type="button" class="model-prefix-toggle" data-action="toggle-prefix" data-prefix-key="${escapeHtml(prefixKey)}" aria-expanded="${state.expandedPrefixes.has(prefixKey)}"><span class="prefix-title"><span class="prefix-arrow" aria-hidden="true"></span><code>${escapeHtml(prefix)}</code></span><span class="prefix-meta">${selectedCount}/${completeModels.length} 已选</span></button><div class="model-group-actions"><button type="button" class="text-button" data-action="select-prefix" data-prefix="${escapeHtml(prefix)}">全部勾选</button><button type="button" class="text-button" data-action="clear-prefix" data-prefix="${escapeHtml(prefix)}">全部取消</button></div></div><div class="model-prefix-body">${visibleModels.map((model) => renderModelRow(model, selections)).join('')}</div></section>`;
}

function renderModelCatalog() {
  const list = $('#modelCatalogList');
  if (!list) return;
  const catalog = state.catalog;
  if (!catalog?.upstreams?.length) {
    list.innerHTML = '<div class="empty">暂无模型目录。请先添加上游，然后点击“拉取全部模型”；Anthropic 上游需要在上游表单中手工填写模型。</div>';
    return;
  }
  const selections = catalogSelectionMap();
  const allModels = allUnifiedModels();
  const visibleModels = filteredUnifiedModels(allModels);
  const prefixGroups = groupModelsByPrefix(visibleModels);
  list.innerHTML = prefixGroups.length ? prefixGroups.map((group) => renderPrefixGroup(group.prefix, group.models, allModels, selections)).join('') : '<div class="empty">没有匹配的模型。</div>';
}

function render() {
  if (!state.config) return;
  const { upstreams: rawUpstreams, routes: rawRoutes, localApiKeys: rawLocalApiKeys } = state.config;
  const upstreams = orderedItems('upstreams', rawUpstreams);
  const routes = orderedItems('routes', rawRoutes);
  const localApiKeys = orderedItems('localApiKeys', rawLocalApiKeys);
  const healthById = new Map((state.health?.items || []).map((item) => [item.upstreamId, item]));
  const balanceById = new Map((state.balances?.items || []).map((item) => [item.upstreamId, item]));
  $('#upstreamList').innerHTML = upstreams.length ? upstreams.map((item) => `
    <article class="item-card" draggable="true" data-card-id="${escapeHtml(item.id)}">
      <button type="button" class="drag-handle" data-drag-handle aria-label="拖动调整上游卡片位置" title="拖动排序">⋮⋮</button>
      <div><div class="item-title">${escapeHtml(item.name)}</div>
        <div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">${item.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}</span><span class="tag">${escapeHtml(clientIdentityLabel(item))}</span><span class="tag ${healthById.get(item.id)?.state === 'open' ? 'off' : 'active'}">${healthLabel(healthById.get(item.id))}</span><span>${escapeHtml(item.baseUrl)}</span></div>
        <div class="item-meta"><span>Key：${escapeHtml(item.apiKey)}</span><span>模型：${escapeHtml(uniqueModelLabels(item.models).join(', ') || '未填写（依赖路由）')}</span>${item.modelsSyncedAt ? `<span>同步于：${escapeHtml(formatTime(item.modelsSyncedAt))}</span>` : ''}${healthById.get(item.id)?.consecutiveFailures ? `<span>连续失败：${escapeHtml(healthById.get(item.id).consecutiveFailures)} 次</span>` : ''}${healthById.get(item.id)?.openUntil ? `<span>冷却至：${escapeHtml(formatTime(healthById.get(item.id).openUntil))}</span>` : ''}</div>
        <div class="item-meta balance-meta">${balanceDetails(balanceById.get(item.id))}</div>
      </div><div class="item-actions"><button class="text-button" data-action="query-upstream-balance" data-id="${escapeHtml(item.id)}">查询余额</button><button class="text-button" data-action="test-upstream" data-id="${escapeHtml(item.id)}">测试连接</button><button class="text-button" data-action="reset-health" data-id="${escapeHtml(item.id)}">重置状态</button><button class="text-button" data-action="sync-upstream" data-id="${escapeHtml(item.id)}">同步模型</button><button class="text-button" data-action="probe-upstream-thinking" data-id="${escapeHtml(item.id)}" title="用极小探测请求确认该站模型支持的思考强度">探测思考</button><button class="text-button" data-action="edit-upstream" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-upstream" data-id="${escapeHtml(item.id)}">删除</button></div>
    </article>`).join('') : '<div class="empty">还没有上游站点。添加一个 sub2api / newapi 地址后即可开始路由。</div>';

  $('#routeList').innerHTML = routes.length ? routes.map((item) => {
    const upstream = upstreams.find((candidate) => candidate.id === item.upstreamId);
    const fallbacks = (item.fallbackUpstreamIds || []).map((id) => upstreams.find((candidate) => candidate.id === id)?.name || '已删除').join(' → ');
    const strategy = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' }[item.strategy || 'failover'] || '故障转移';
    const protocolTag = item.responsesMode === 'native' ? '<span class="tag">协议：Responses</span>' : item.responsesMode === 'chat' ? '<span class="tag">协议：Chat</span>' : '';
    return `<article class="item-card" draggable="true" data-card-id="${escapeHtml(item.id)}"><button type="button" class="drag-handle" data-drag-handle aria-label="拖动调整路由卡片位置" title="拖动排序">⋮⋮</button><div><div class="item-title"><code>${escapeHtml(item.localModel)}</code> <span class="muted">→</span> <code>${escapeHtml(item.upstreamModel)}</code></div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span class="tag">策略：${strategy}</span>${protocolTag}<span>主上游：${escapeHtml(upstream?.name || '已删除')}</span>${fallbacks ? `<span>备用：${escapeHtml(fallbacks)}</span>` : ''}</div></div><div class="item-actions"><button class="text-button" data-action="edit-route" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button delete" data-action="delete-route" data-id="${escapeHtml(item.id)}">删除</button></div></article>`;
  }).join('') : '<div class="empty">还没有路由。只有一个启用的上游时，未配置路由的模型会自动转发。</div>';

  $('#keyList').innerHTML = localApiKeys.length ? localApiKeys.map((item) => `<article class="item-card" draggable="true" data-card-id="${escapeHtml(item.id)}"><button type="button" class="drag-handle" data-drag-handle aria-label="拖动调整 Key 卡片位置" title="拖动排序">⋮⋮</button><div><div class="item-title">${escapeHtml(item.name)}</div><div class="key-value">${escapeHtml(item.key)}</div>${keyAccessBadge(item)}<div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span><span>创建于 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span></div></div><div class="item-actions"><button class="text-button" data-action="copy-key" data-id="${escapeHtml(item.id)}">复制</button><button class="text-button" data-action="edit-key" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button" data-action="toggle-key" data-id="${escapeHtml(item.id)}">${item.enabled ? '停用' : '启用'}</button><button class="text-button delete" data-action="delete-key" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join('') : '<div class="empty">还没有本地调用 Key。</div>';

  const settings = state.config.settings || {};
  $('#upstreamTimeoutMs').value = settings.upstreamTimeoutMs ?? 600000;
  $('#upstreamRetries').value = settings.upstreamRetries ?? 0;
  $('#maxFallbackAttempts').value = settings.maxFallbackAttempts ?? 0;
  $('#retryDelayMs').value = settings.retryDelayMs ?? 0;
  $('#circuitBreakerFailureThreshold').value = settings.circuitBreakerFailureThreshold ?? 3;
  $('#circuitBreakerCooldownMs').value = settings.circuitBreakerCooldownMs ?? 60000;
  $('#maxConcurrentRequests').value = settings.maxConcurrentRequests ?? 0;
  $('#requestsPerMinute').value = settings.requestsPerMinute ?? 0;
  $('#errorPrefix').value = settings.errorPrefix ?? '';

  renderMetrics();
  renderModelCatalog();
  enableCardDragging('upstreams', $('#upstreamList'));
  enableCardDragging('routes', $('#routeList'));
  enableCardDragging('localApiKeys', $('#keyList'));

  const origin = window.location.origin;
  $('#openaiEndpoint').textContent = `${origin}/v1`;
  $('#anthropicEndpoint').textContent = `${origin}/v1`;
  $('#modelsEndpoint').textContent = `${origin}/v1/models`;
}

function downloadJson(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportUsage(scope) {
  try {
    const data = await api(`/api/admin/metrics/export?scope=${scope}`);
    const label = scope === 'all' ? 'all' : 'recent-100';
    downloadJson(`Sakura-AI-Gateway-usage-${label}-${new Date().toISOString().slice(0, 10)}.json`, data);
    toast(scope === 'all' ? `已导出全部 ${data.records.length} 条用量记录` : `已导出最近 ${data.records.length} 条历史记录`);
  } catch (error) { toast(error.message, 'error'); }
}

function renderMetrics(options = {}) {
  const range = state.metricsRange;
  // 渲染数据源：范围模式下用范围结果，否则用全量统计。
  const source = range ? range.data : state.metrics;
  if (!source) {
    $('#statsGrid').innerHTML = '<div class="empty">统计暂时不可用。</div>';
    $('#requestLogMore')?.classList.add('hidden');
    return;
  }
  const totals = source.totals || {};
  const successRate = totals.requests ? `${((totals.successful / totals.requests) * 100).toFixed(1)}%` : '0%';
  // 每个统计独占一行，数字再长也不会互相挤压或被裁掉。
  $('#statsGrid').innerHTML = [
    ['请求总数', formatNumber(totals.requests)],
    ['成功率', successRate],
    ['故障转移', formatNumber(totals.failovers)],
    ['总 Token', formatNumber(totals.totalTokens)],
    ['输入 Token', formatNumber(totals.promptTokens)],
    ['输出 Token', formatNumber(totals.completionTokens)]
  ].map(([label, value]) => `<div class="stat-card"><div class="stat-value">${escapeHtml(value)}</div><div class="stat-label">${escapeHtml(label)}</div></div>`).join('');

  const scopeTitle = $('#metricsScopeTitle');
  if (scopeTitle) {
    scopeTitle.textContent = range
      ? `按上游统计（${range.from.replace('T', ' ')} ~ ${range.to.replace('T', ' ')}，命中 ${formatNumber(source.matched ?? 0)} 条）`
      : '按上游统计（全部）';
  }
  const upstreamEntries = Object.entries(source.byUpstream || {});
  $('#upstreamStats').innerHTML = upstreamEntries.length ? upstreamEntries.map(([name, item]) => `<div class="upstream-stat"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><span>请求 ${formatNumber(item.requests)} · 成功 ${formatNumber(item.successful)} · 失败 ${formatNumber(item.failed)}<br>Token ${formatNumber(item.totalTokens)}</span></div>`).join('') : `<div class="empty">${range ? '该时间范围内没有请求记录。' : '还没有上游请求统计。'}</div>`;

  // 范围统计只替换统计卡片，请求日志仍跟随全量快照。
  const logs = state.metrics?.logs || [];
  state.logPage = state.metrics?.logPage || { offset: 0, limit: logs.length, total: logs.length, hasMore: false, maxLogs: logs.length };
  if (!options.preserveLogs) {
    $('#metricsEmpty').classList.toggle('hidden', logs.length > 0);
    $('#requestLogBody').innerHTML = logs.map(renderLogRow).join('');
  }
  updateLogSummary();
}

async function refreshMetrics() {
  if (!state.config || state.metricsRefreshInFlight) return;
  state.metricsRefreshInFlight = true;
  try {
    if (state.metricsRange) {
      // 范围模式下刷新的是同一时间窗口，新请求会计入当前视图。
      state.metricsRange = await loadMetricsRange(state.metricsRange.from, state.metricsRange.to);
    } else {
      state.metrics = await api('/api/admin/metrics');
    }
    renderMetrics({ preserveLogs: true });
  } catch {
    // Keep the last successful snapshot visible during a temporary failure.
  } finally {
    state.metricsRefreshInFlight = false;
  }
}

// datetime-local 是本地时间，转成 ISO 后由后端按闭区间解析。
function formatRangeInput(value) { return value ? new Date(value).toISOString() : ''; }

async function loadMetricsRange(from, to) {
  const data = await api(`/api/admin/metrics/range?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  return { from, to, data };
}

function fillDefaultRangeInputs() {
  const from = $('#metricsRangeFrom');
  const to = $('#metricsRangeTo');
  if (!from || !to || from.value || to.value) return;
  const pad = (value) => String(value).padStart(2, '0');
  const format = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const now = new Date();
  from.value = format(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0));
  to.value = format(now);
}

async function applyMetricsRange() {
  const fromInput = $('#metricsRangeFrom')?.value || '';
  const toInput = $('#metricsRangeTo')?.value || '';
  if (!fromInput || !toInput) { toast('请先选择开始和结束时间'); return; }
  const from = formatRangeInput(fromInput);
  const to = formatRangeInput(toInput);
  if (new Date(from) > new Date(to)) { toast('开始时间不能晚于结束时间'); return; }
  try {
    state.metricsRange = await loadMetricsRange(from, to);
    renderMetrics({ preserveLogs: true });
    toast(`已统计 ${state.metricsRange.data.matched} 条时间范围内的请求`);
  } catch (error) { toast(error.message, 'error'); }
}

function resetMetricsRange() {
  state.metricsRange = null;
  renderMetrics({ preserveLogs: true });
  toast('已返回全部时间段的请求统计');
}

const STRATEGY_LABELS = { failover: '故障转移', round_robin: '轮询', weighted: '加权轮询', random: '随机' };

function renderLogDetailRow(diag) {
  const section = (title, text) => (text
    ? `<div class="diag-section"><div class="diag-title">${title}</div><pre>${escapeHtml(text)}</pre></div>`
    : '');
  const list = (title, items) => (Array.isArray(items) && items.length
    ? `<div class="diag-section diag-warnings"><div class="diag-title">${title}</div><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '');
  const meta = [
    `上游路径：${escapeHtml(diag.upstreamPath || '-')}`,
    diag.nativeResponses ? '接口：Responses 原生' : '接口：Chat Completions',
    diag.responsesMode ? `协议模式：${escapeHtml(diag.responsesMode)}` : ''
  ].filter(Boolean).join(' ｜ ');
  const body = `<div class="diag-meta">${meta}</div>`
    + section('上游请求（网关发出）', diag.upstreamRequest)
    + section('上游响应样本（前若干帧）', (diag.upstreamResponse || []).join('\n'))
    + section('网关输出样本（发给客户端，前若干帧）', (diag.output || []).join('\n'))
    + list('警告', diag.warnings);
  return `<tr class="log-detail-row hidden"><td colspan="10">${body}</td></tr>`;
}

function renderLogRow(entry) {
  const upstreamError = entry.upstreamError || null;
  const errorParts = [];
  if (entry.error) errorParts.push(entry.error);
  if (upstreamError) {
    errorParts.push([
      upstreamError.status ? `HTTP ${upstreamError.status}` : null,
      upstreamError.code ? `code：${upstreamError.code}` : null,
      upstreamError.type ? `type：${upstreamError.type}` : null,
      upstreamError.param ? `param：${upstreamError.param}` : null
    ].filter(Boolean).join(' | '));
  }
  const errorTitle = errorParts.length ? ` title="${escapeHtml(errorParts.join('\n'))}"` : '';
  const upstreamCodeTag = upstreamError?.code ? `<span class="small-tag">code：${escapeHtml(upstreamError.code)}</span>` : '';
  const protocol = { openai: 'Chat', anthropic: 'Messages', responses: 'Responses' }[entry.protocol] || entry.protocol || '-';
  const model = entry.upstreamModel && entry.upstreamModel !== entry.model
    ? `<code>${escapeHtml(entry.model)}</code><span class="log-detail">→ ${escapeHtml(entry.upstreamModel)}</span>`
    : `<code>${escapeHtml(entry.model || '-')}</code>`;
  const attempts = (entry.attempts || []).map((attempt) => {
    const label = `${attempt.upstream} (${attempt.status ?? '连接失败'})`;
    // 同一上游的第 N 次原地重试，让「重试→切换」的顺序在日志里可读。
    const retryTag = attempt.retry ? ` · 第${attempt.retry + 1}次` : '';
    return attempt.error?.code ? `${label}${retryTag} · ${attempt.error.code}` : `${label}${retryTag}`;
  }).join(' → ');
  const strategy = escapeHtml(STRATEGY_LABELS[entry.strategy] || entry.strategy || '故障转移');
  const attemptDetail = attempts ? `<span class="log-detail" title="${escapeHtml(attempts)}">${escapeHtml(attempts)}</span>` : '';
  const hasDiag = Boolean(entry.diagnostics);
  const rowClass = `log-row${hasDiag ? ' log-row-expandable' : ''}`;
  const main = `<tr class="${rowClass}"><td><code>${escapeHtml(entry.id || '-')}</code>${hasDiag ? '<span class="small-tag">诊断</span>' : ''}</td><td>${escapeHtml(formatTime(entry.finishedAt || entry.startedAt))}</td><td>${escapeHtml(protocol)}${entry.stream ? '<span class="small-tag">流式</span>' : ''}</td><td>${model}</td><td>${strategy}${attemptDetail}</td><td>${escapeHtml(entry.upstream || '-')}</td><td>${escapeHtml(entry.status)}</td><td>${escapeHtml(entry.durationMs)} ms</td><td>${escapeHtml(entry.usage?.totalTokens || 0)}</td><td class="log-result ${entry.success ? 'success-text' : 'error-text'}"${errorTitle}>${entry.success ? '成功' : `失败：${escapeHtml(entry.error || '未知错误')}`}${upstreamCodeTag}${entry.failover ? '<span class="small-tag">已切换</span>' : ''}</td></tr>`;
  return hasDiag ? main + renderLogDetailRow(entry.diagnostics) : main;
}

function updateLogSummary() {
  const page = state.logPage || {};
  const shown = $('#requestLogBody').querySelectorAll('.log-row').length;
  const summary = $('#requestLogSummary');
  if (summary) {
    const maxLabel = page.maxLogs ? `，最多保留最近 ${formatNumber(page.maxLogs)} 条` : '';
    const sampleLabel = shown ? '，点击「诊断」行查看上游请求与输出样本' : '，仅记录元数据';
    summary.textContent = page.total ? `已显示 ${formatNumber(shown)} / ${formatNumber(page.total)} 条${maxLabel}${sampleLabel}` : '仅记录元数据';
  }
  const more = $('#requestLogMore');
  if (more) more.classList.toggle('hidden', !page.hasMore);
}

async function loadMoreLogs() {
  if (state.loadingMoreLogs || !state.logPage?.hasMore) return;
  state.loadingMoreLogs = true;
  const button = $('#loadMoreLogsButton');
  if (button) { button.disabled = true; button.textContent = '加载中…'; }
  const shown = $('#requestLogBody').querySelectorAll('.log-row').length;
  try {
    const page = await api(`/api/admin/metrics/logs?offset=${shown}&limit=100`);
    $('#requestLogBody').insertAdjacentHTML('beforeend', (page.items || []).map(renderLogRow).join(''));
    state.logPage = { ...state.logPage, offset: page.offset, total: page.total, hasMore: page.hasMore, maxLogs: page.maxLogs };
    updateLogSummary();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.loadingMoreLogs = false;
    if (button) { button.disabled = false; button.textContent = '加载更多'; }
  }
}

async function refreshRequestLogs() {
  const button = $('#refreshLogsButton');
  if (button) { button.disabled = true; button.textContent = '刷新中…'; }
  try {
    const page = await api('/api/admin/metrics/logs?offset=0&limit=100');
    const items = page.items || [];
    $('#requestLogBody').innerHTML = items.map(renderLogRow).join('');
    $('#metricsEmpty').classList.toggle('hidden', items.length > 0);
    state.logPage = page;
    updateLogSummary();
  } catch (error) {
    toast(`刷新请求日志失败：${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '刷新日志'; }
  }
}

async function loadConfig() {
  setMessage('正在读取配置…');
  try {
    state.config = await api('/api/admin/config');
    $('#currentVersion').textContent = state.config.appVersion || state.config.version || '-';
    $('#aboutVersion').textContent = state.config.appVersion || state.config.version || '-';
    try {
      state.metrics = await api('/api/admin/metrics');
    } catch {
      state.metrics = null;
    }
    try {
      state.health = await api('/api/admin/upstream-status');
    } catch {
      state.health = null;
    }
    try {
      state.balances = await api('/api/admin/upstream-balances');
    } catch {
      state.balances = null;
    }
    try {
      state.catalog = await api('/api/admin/model-catalog');
      reconcileModelSelectionDraft(state.catalog);
    } catch {
      state.catalog = null;
      state.modelSelectionDraft = null;
    }
    try {
      state.adminAuth = await api('/api/admin/admin-auth');
      renderAdminAuth();
    } catch {
      state.adminAuth = null;
    }
    try { await loadIntegrations(); } catch { /* 接入列表失败不阻塞面板 */ }
    $('#dashboard').classList.remove('hidden');
    setMessage('');
    fillDefaultRangeInputs();
    render();
    switchTab(state.activeTab || 'overview');
  } catch (error) {
    $('#dashboard').classList.add('hidden');
    setMessage(error.message, 'error');
  }
}

async function initializeAdminAccess() {
  try {
    const response = await fetch('/auth/status', { headers: { Accept: 'application/json' } });
    const status = await response.json().catch(() => ({}));
    if (!response.ok || !status.authenticated) {
      $('#adminIdentity').textContent = '尚未认证';
      setMessage(status.error?.message || `认证状态检查失败（${response.status}）`, 'error');
      return;
    }
    if (status.mode === 'local') {
      $('#adminIdentity').textContent = '本机管理员';
    } else if (status.mode === 'password') {
      $('#adminIdentity').textContent = status.user?.username || '本地账号管理员';
    } else {
      const identity = status.user?.username || status.user?.name || status.user?.email || 'OIDC 用户';
      $('#adminIdentity').textContent = identity;
    }
    await loadConfig();
  } catch (error) {
    $('#adminIdentity').textContent = '认证状态不可用';
    setMessage(error.message, 'error');
  }
}

function collectModelSelections() {
  syncRenderedModelDraft();
  return [...catalogSelectionMap().values()];
}

async function saveModelSelections() {
  const message = $('#modelSelectionMessage');
  try {
    const selections = collectModelSelections();
    state.catalog = await api('/api/admin/model-selections', { method: 'PUT', body: JSON.stringify({ selections }) });
    reconcileModelSelectionDraft(state.catalog, true);
    await loadConfig();
    message.textContent = `已保存 ${selections.length} 个本地模型。未勾选模型不会再出现在 /v1/models。`;
    message.className = 'form-message success';
    toast(`已暴露 ${selections.length} 个本地模型`);
  } catch (error) {
    message.textContent = error.message;
    message.className = 'form-message error';
    toast(error.message, 'error');
  }
}

async function syncAllModels() {
  const button = $('#syncAllModelsButton');
  button.disabled = true;
  button.textContent = '拉取中…';
  try {
    const result = await api('/api/admin/model-catalog/sync', { method: 'POST', body: '{}' });
    state.catalog = result.catalog;
    reconcileModelSelectionDraft(state.catalog);
    renderModelCatalog();
    const failed = result.results.filter((item) => !item.ok && !item.skipped);
    toast(failed.length ? `模型拉取完成，但有 ${failed.length} 个上游失败` : '全部上游模型已拉取');
  } catch (error) { toast(error.message, 'error'); }
  button.disabled = false;
  button.textContent = '拉取全部模型';
}

function thinkingProbeSummary(results) {
  return results.reduce((totals, item) => ({
    probed: totals.probed + (item.probed || 0),
    supported: totals.supported + (item.supported || 0),
    unsupported: totals.unsupported + (item.unsupported || 0),
    skipped: totals.skipped + (item.skipped || 0),
    failed: totals.failed + (item.failed || 0),
    busy: totals.busy || item.status === 'busy'
  }), { probed: 0, supported: 0, unsupported: 0, skipped: 0, failed: 0, busy: false });
}

function applyThinkingProbeResult(result) {
  if (!result?.catalog) return;
  state.catalog = result.catalog;
  reconcileModelSelectionDraft(state.catalog);
  renderModelCatalog();
}

async function probeAllThinking() {
  const button = $('#probeThinkingButton');
  button.disabled = true;
  button.textContent = '探测中…';
  try {
    const result = await api('/api/admin/model-catalog/thinking-probe', { method: 'POST', body: '{}' });
    applyThinkingProbeResult(result);
    const totals = thinkingProbeSummary(result.results || []);
    const failedHint = totals.failed || totals.busy ? `，失败/跳过 ${totals.failed}${totals.busy ? '（有上游正在探测）' : ''}` : '';
    toast(`思考强度探测完成：探测 ${totals.probed} 个（支持 ${totals.supported}、不支持 ${totals.unsupported}），跳过 ${totals.skipped}${failedHint}`, totals.failed ? 'error' : '');
  } catch (error) {
    toast(`思考强度探测失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '拉取思考强度';
  }
}

async function queryAllBalances() {
  const button = $('#queryAllBalancesButton');
  button.disabled = true;
  button.textContent = '查询中…';
  try {
    state.balances = await api('/api/admin/upstream-balances/query', { method: 'POST', body: '{}' });
    render();
    const succeeded = state.balances.items.filter((item) => item.state === 'ok').length;
    const unsupported = state.balances.items.filter((item) => item.state === 'unsupported').length;
    const failed = state.balances.items.length - succeeded - unsupported;
    toast(`余额查询完成：成功 ${succeeded}，不支持 ${unsupported}，失败 ${failed}${failed ? '；请查看上游卡片详情' : ''}`, failed ? 'error' : '');
  } catch (error) {
    toast(`查询全部余额失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '查询全部余额';
  }
}

function setBalanceResult(result) {
  const items = (state.balances?.items || []).filter((item) => item.upstreamId !== result.upstreamId);
  state.balances = { items: [...items, result] };
}

function togglePrefix(prefixKey) {
  syncRenderedModelDraft();
  if (state.expandedPrefixes.has(prefixKey)) state.expandedPrefixes.delete(prefixKey);
  else state.expandedPrefixes.add(prefixKey);
  renderModelCatalog();
}

function expandModelGroups(expanded) {
  syncRenderedModelDraft();
  state.expandedPrefixes = expanded
    ? new Set(groupModelsByPrefix(allUnifiedModels()).map((group) => modelGroupKey('unified', group.prefix)))
    : new Set();
  renderModelCatalog();
}

function batchSelectModels(prefix, selected) {
  syncRenderedModelDraft();
  const models = allUnifiedModels().filter((model) => modelPrefix(model.id) === prefix);
  state.modelSelectionDraft = setUnifiedModelsSelected(catalogSelectionMap(), models, selected);
  renderModelCatalog();
  toast(`${prefix} 已${selected ? '全部勾选' : '全部取消'}`);
}

function updateClientIdentityFields() {
  const custom = $('#upstreamClientIdentityPreset').value === 'custom';
  $('#customUserAgentLabel').classList.toggle('hidden', !custom);
  $('#upstreamCustomUserAgent').required = custom;
}

function fillUpstreamForm(item = null) {
  $('#upstreamDialogTitle').textContent = item ? '编辑上游' : '添加上游';
  $('#upstreamId').value = item?.id || '';
  $('#upstreamName').value = item?.name || '';
  $('#upstreamBaseUrl').value = item?.baseUrl || '';
  $('#upstreamProtocol').value = item?.protocol || 'openai';
  $('#upstreamAuthType').value = item?.authType || (item?.protocol === 'anthropic' ? 'x-api-key' : 'bearer');
  $('#upstreamApiKey').value = '';
  $('#upstreamApiKey').placeholder = item ? '留空表示保留原 Key' : '输入上游 API Key';
  $('#upstreamClientIdentityPreset').value = item?.clientIdentityPreset || 'default';
  $('#upstreamCustomUserAgent').value = item?.customUserAgent || '';
  updateClientIdentityFields();
  $('#upstreamResponsesMode').value = item?.responsesMode || 'auto';
  $('#upstreamBalanceEndpoint').value = item?.balanceEndpoint || '';
  $('#upstreamModels').value = uniqueModelLabels(item?.models).join('\n');
  $('#upstreamModelFetchMessage').textContent = '从上游的 /v1/models 自动获取';
  $('#upstreamModelFetchMessage').className = 'muted';
  $('#upstreamEnabled').checked = item?.enabled !== false;
  openDialog($('#upstreamDialog'));
}

function fillRouteForm(item = null) {
  $('#routeDialogTitle').textContent = item ? '编辑路由' : '添加路由';
  $('#routeId').value = item?.id || '';
  $('#localModel').value = item?.localModel || '';
  $('#routeUpstreamId').innerHTML = state.config.upstreams.map((upstream) => `<option value="${escapeHtml(upstream.id)}">${escapeHtml(upstream.name)} (${escapeHtml(upstream.protocol)})</option>`).join('');
  $('#routeUpstreamId').value = item?.upstreamId || state.config.upstreams[0]?.id || '';
  $('#routeUpstreamModel').value = item?.upstreamModel || '';
  $('#routeThinkingLevel').innerHTML = thinkingLevelOptions(THINKING_GRADES, item?.thinkingLevel || 'client');
  $('#routeModalityTranslator').innerHTML = translatorOptions(item?.modalityTranslator, item?.localModel);
  $('#routeResponsesMode').value = item?.responsesMode || 'auto';
  $('#routeStrategy').value = item?.strategy || 'failover';
  $('#routeFallbackIds').innerHTML = state.config.upstreams.map((upstream) => `<option value="${escapeHtml(upstream.id)}">${escapeHtml(upstream.name)} (${escapeHtml(upstream.protocol)})</option>`).join('');
  for (const option of $('#routeFallbackIds').options) option.selected = (item?.fallbackUpstreamIds || []).includes(option.value);
  $('#routeWeights').innerHTML = state.config.upstreams.map((upstream) => `<div class="route-weight-row"><span>${escapeHtml(upstream.name)}</span><input type="number" min="1" max="1000" step="1" data-upstream-id="${escapeHtml(upstream.id)}" value="${escapeHtml(item?.upstreamWeights?.[upstream.id] || 1)}"></div>`).join('');
  $('#routeEnabled').checked = item?.enabled !== false;
  openDialog($('#routeDialog'));
}

function fillKeyAccessForm(form, item = {}) {
  const access = normalizeKeyAccess(item);
  for (const radio of form.querySelectorAll('input[type="radio"]')) radio.checked = radio.value === access.modelAccessMode;
  const tree = form.querySelector('.key-model-tree');
  const models = keyAccessModels(state.config);
  const known = new Set(models.map((model) => unifiedModelSelectionKey(model.id)));
  // 暂时下架的已保存授权仍可看到/取消，不能因编辑名称而悄悄丢掉。
  for (const id of access.allowedModels) {
    if (!known.has(unifiedModelSelectionKey(id))) models.push({ id, group: modelPrefix(id), unavailable: true });
  }
  const groups = new Map(access.allowedGroups.map((group) => [group, []]));
  for (const model of models) {
    if (!groups.has(model.group)) groups.set(model.group, []);
    groups.get(model.group).push(model);
  }
  const selected = new Set(access.allowedModels.map(unifiedModelSelectionKey));
  tree.innerHTML = '<p class="help">先启用分组，再勾选模型；只启用分组不会自动授权。全选仅选择当前列表，新同步模型需另外勾选。别名按目标模型分组、独立授权。</p>'
    + [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => `
      <section class="key-group">
        <div class="key-group-header">
          <label class="check-label"><input type="checkbox" data-key-group="${escapeHtml(group)}" ${access.allowedGroups.includes(group) ? 'checked' : ''}><span class="key-group-title">${escapeHtml(group)}</span></label>
          <span class="key-group-meta"></span>
          <button type="button" class="text-button" data-action="key-toggle-group" aria-expanded="true" aria-label="展开或收起 ${escapeHtml(group)}"><span class="key-group-arrow" aria-hidden="true"></span></button>
        </div>
        <div class="key-group-body">
          <div class="item-actions"><button type="button" class="text-button" data-action="key-select-group">组内全选</button><button type="button" class="text-button" data-action="key-clear-group">组内清空</button></div>
          ${items.map((model) => `<label class="key-model-item"><input type="checkbox" data-key-model="${escapeHtml(model.id)}" ${selected.has(unifiedModelSelectionKey(model.id)) ? 'checked' : ''}><span>${escapeHtml(model.id)}${model.unavailable ? '（当前未发布，仅保留配置）' : model.upstreamModel !== model.id ? ` → ${escapeHtml(model.upstreamModel)}` : ''}</span></label>`).join('') || '<span class="muted">当前没有模型</span>'}
        </div>
      </section>`).join('')
    + (groups.size ? '' : '<div class="empty">暂无可授权模型，请先配置上游或发布本地模型。自定义范围为空时禁止全部模型。</div>');
  updateKeyAccessForm(form);
}

function updateKeyAccessForm(form) {
  const tree = form.querySelector('.key-model-tree');
  tree.classList.toggle('hidden', form.querySelector('input[type="radio"]:checked').value !== 'custom');
  for (const group of tree.querySelectorAll('.key-group')) {
    const enabled = group.querySelector('[data-key-group]').checked;
    const models = [...group.querySelectorAll('[data-key-model]')];
    for (const model of models) model.disabled = !enabled;
    for (const button of group.querySelectorAll('.key-group-body button')) button.disabled = !enabled;
    group.querySelector('.key-group-meta').textContent = `${enabled ? models.filter((model) => model.checked).length : 0}/${models.length} 可用${enabled ? '' : '（未启用）'}`;
  }
}

function keyAccessPayload(form) {
  // 被禁用的模型复选框（所属分组未启用）仍可能保持勾选状态，
  // :checked 会照常匹配它们，所以必须显式排除，否则保存的权限与界面不一致。
  const enabledModels = (selector) => [...form.querySelectorAll(selector)].filter((input) => !input.disabled);
  return normalizeKeyAccess({
    modelAccessMode: form.querySelector('input[type="radio"]:checked').value,
    allowedGroups: [...form.querySelectorAll('[data-key-group]:checked')].map((input) => input.dataset.keyGroup),
    allowedModels: enabledModels('[data-key-model]:checked').map((input) => input.dataset.keyModel)
  });
}

function bindKeyAccessForm(form) {
  form.addEventListener('change', () => updateKeyAccessForm(form));
  form.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const group = button.closest('.key-group');
    if (!group) return;
    if (button.dataset.action === 'key-toggle-group') {
      const collapsed = group.classList.toggle('collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
    } else if (['key-select-group', 'key-clear-group'].includes(button.dataset.action)) {
      for (const model of group.querySelectorAll('[data-key-model]')) model.checked = button.dataset.action === 'key-select-group';
      updateKeyAccessForm(form);
    }
  });
}

function keyAccessBadge(item) {
  if (!item.modelAccessMode || item.modelAccessMode === 'all') return '<span class="key-perm-badge">全部模型</span>';
  return `<span class="key-perm-badge restricted">自定义：${escapeHtml((item.allowedGroups || []).join('、') || '无分组')} · ${(item.allowedModels || []).length} 项勾选</span>`;
}

function fillKeyEditForm(item) {
  $('#editKeyId').value = item.id;
  $('#editKeyName').value = item.name;
  $('#editKeyEnabled').checked = item.enabled !== false;
  fillKeyAccessForm($('#keyEditForm'), item);
  openDialog($('#keyEditDialog'));
}

function upstreamPayloadFromForm() {
  return {
    name: $('#upstreamName').value.trim(), baseUrl: $('#upstreamBaseUrl').value.trim(), protocol: $('#upstreamProtocol').value,
    authType: $('#upstreamAuthType').value, apiKey: $('#upstreamApiKey').value, models: $('#upstreamModels').value,
    clientIdentityPreset: $('#upstreamClientIdentityPreset').value,
    customUserAgent: $('#upstreamClientIdentityPreset').value === 'custom' ? $('#upstreamCustomUserAgent').value.trim() : '',
    responsesMode: $('#upstreamResponsesMode').value,
    balanceEndpoint: $('#upstreamBalanceEndpoint').value.trim(),
    enabled: $('#upstreamEnabled').checked
  };
}

async function fetchUpstreamModels() {
  const button = $('#fetchUpstreamModelsButton');
  const message = $('#upstreamModelFetchMessage');
  const payload = upstreamPayloadFromForm();
  if (!payload.baseUrl) {
    message.textContent = '请先填写上游地址';
    message.className = 'error';
    return;
  }
  if (payload.authType !== 'none' && !payload.apiKey && !$('#upstreamId').value) {
    message.textContent = '请先填写上游 API Key';
    message.className = 'error';
    return;
  }
  button.disabled = true;
  button.textContent = '拉取中…';
  message.textContent = '正在请求上游模型列表…';
  message.className = 'muted';
  try {
    const result = await api('/api/admin/model-catalog/preview', {
      method: 'POST',
      body: JSON.stringify({ ...payload, upstreamId: $('#upstreamId').value })
    });
    $('#upstreamModels').value = uniqueModelLabels(result.models).join('\n');
    message.textContent = `已拉取 ${result.count} 个模型，请点击“保存上游”完成保存`;
    message.className = 'success';
    toast(`已从上游拉取 ${result.count} 个模型`);
  } catch (error) {
    message.textContent = error.message;
    message.className = 'error';
    toast(`拉取模型失败：${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '拉取模型';
  }
}

async function saveUpstream(event) {
  event.preventDefault();
  const id = $('#upstreamId').value;
  const payload = upstreamPayloadFromForm();
  try {
    await api(id ? `/api/admin/upstreams/${encodeURIComponent(id)}` : '/api/admin/upstreams', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog($('#upstreamDialog'));
    await loadConfig();
    toast('上游已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function saveRoute(event) {
  event.preventDefault();
  const id = $('#routeId').value;
  const upstreamWeights = Object.fromEntries([...$('#routeWeights').querySelectorAll('input[data-upstream-id]')].map((input) => [input.dataset.upstreamId, Number(input.value)]));
  const payload = { localModel: $('#localModel').value.trim(), upstreamId: $('#routeUpstreamId').value, upstreamModel: $('#routeUpstreamModel').value.trim(), thinkingLevel: $('#routeThinkingLevel').value, modalityTranslator: $('#routeModalityTranslator').value, responsesMode: $('#routeResponsesMode').value, strategy: $('#routeStrategy').value, fallbackUpstreamIds: [...$('#routeFallbackIds').selectedOptions].map((option) => option.value), upstreamWeights, enabled: $('#routeEnabled').checked };
  try {
    await api(id ? `/api/admin/routes/${encodeURIComponent(id)}` : '/api/admin/routes', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog($('#routeDialog'));
    await loadConfig();
    toast('路由已保存');
  } catch (error) { toast(error.message, 'error'); }
}

async function deleteItem(kind, id, label) {
  if (!window.confirm(`确定删除${label}吗？`)) return;
  try {
    await api(`/api/admin/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadConfig();
    toast(`${label}已删除`);
  } catch (error) { toast(error.message, 'error'); }
}

async function saveKeyEdit(event) {
  event.preventDefault();
  const id = $('#editKeyId').value;
  try {
    await api(`/api/admin/local-keys/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name: $('#editKeyName').value.trim(), enabled: $('#editKeyEnabled').checked, ...keyAccessPayload($('#keyEditForm')) }) });
    closeDialog($('#keyEditDialog'));
    await loadConfig();
    toast('本地 Key 已更新');
  } catch (error) { toast(error.message, 'error'); }
}

async function toggleKey(item) {
  try {
    await api(`/api/admin/local-keys/${encodeURIComponent(item.id)}`, { method: 'PUT', body: JSON.stringify({ name: item.name, enabled: item.enabled === false }) });
    await loadConfig();
    toast(`本地 Key 已${item.enabled === false ? '启用' : '停用'}`);
  } catch (error) { toast(error.message, 'error'); }
}

async function copyLocalKey(item) {
  try {
    await navigator.clipboard.writeText(item.key);
    toast(`${item.name} 的 Key 已复制`);
  } catch {
    window.prompt('浏览器无法自动写入剪贴板，请手工复制：', item.key);
  }
}

// 第三方接入授权：列出登记记录，管理员可手动取消。
async function loadIntegrations() {
  try {
    const result = await api('/api/admin/integrations');
    state.integrations = Array.isArray(result.integrations) ? result.integrations : [];
    renderIntegrations();
  } catch (error) {
    state.integrations = [];
    renderIntegrations();
    toast(`接入授权列表加载失败：${error.message}`, 'error');
  }
}

function renderIntegrations() {
  const container = $('#integrationList');
  if (!container) return;
  const items = Array.isArray(state.integrations) ? state.integrations : [];
  if (!items.length) {
    container.innerHTML = '<div class="empty">还没有第三方接入授权。外部软件填入网关地址和本地 Key 后会出现在这里。</div>';
    return;
  }
  container.innerHTML = items.map((item) => {
    const cancelled = item.status === 'cancelled';
    const keyName = item.sourceKey ? `${escapeHtml(item.sourceKey.name)}${item.sourceKey.enabled ? '' : '（已停用）'}` : '<span class="muted">来源 Key 已删除</span>';
    const verified = item.lastVerifiedAt ? `最近验证：${escapeHtml(new Date(item.lastVerifiedAt).toLocaleString())}` : '';
    const failed = item.lastFailureAt ? `最近失败：${escapeHtml(new Date(item.lastFailureAt).toLocaleString())}${item.lastFailureReason ? `（${escapeHtml(item.lastFailureReason)}）` : ''}` : '';
    return `<article class="item-card"><div><div class="item-title">${escapeHtml(item.label || '未命名接入')}${cancelled ? '<span class="tag off">已取消</span>' : '<span class="tag active">已授权</span>'}</div><div class="item-meta"><span>来源 Key：${keyName}</span><span>创建于 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span><span>成功 ${item.successCount} 次 · 失败 ${item.failureCount} 次</span>${verified ? `<span>${verified}</span>` : ''}${failed ? `<span class="error-text">${failed}</span>` : ''}</div>${item.lastFailureReason && cancelled ? `<div class="item-meta"><span class="muted">取消原因：${escapeHtml(item.lastFailureReason)}</span></div>` : ''}</div><div class="item-actions">${cancelled ? '' : `<button class="text-button delete" data-action="revoke-integration" data-id="${escapeHtml(item.id)}">取消授权</button>`}</div></article>`;
  }).join('');
}

async function revokeIntegration(item) {
  if (!item) return;
  if (!window.confirm(`确认取消「${item.label || '未命名接入'}」的授权吗？对方将不能再刷新配置，已签发的调用仍按本地 Key 权限处理。`)) return;
  try {
    await api(`/api/admin/integrations/${encodeURIComponent(item.id)}/revoke`, { method: 'POST', body: '{}' });
    toast('已取消该接入授权');
    await loadIntegrations();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleListClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const item = (button.dataset.action.includes('upstream') ? state.config.upstreams : button.dataset.action.includes('route') ? state.config.routes : state.config.localApiKeys).find((candidate) => candidate.id === button.dataset.id);
  if (button.dataset.action === 'edit-upstream') fillUpstreamForm(item);
  if (button.dataset.action === 'edit-route') fillRouteForm(item);
  if (button.dataset.action === 'revoke-integration') await revokeIntegration(item);
  if (button.dataset.action === 'edit-key') fillKeyEditForm(item);
  if (button.dataset.action === 'toggle-key') await toggleKey(item);
  if (button.dataset.action === 'copy-key') await copyLocalKey(item);
  if (button.dataset.action === 'query-upstream-balance') {
    button.disabled = true;
    button.textContent = '查询中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/balance`, { method: 'POST', body: '{}' });
      setBalanceResult(result);
      render();
      if (result.state === 'ok') toast(`${item?.name || '上游'} 余额查询成功`);
      else toast(`${item?.name || '上游'}：${result.message || '未能查询余额'}`, result.state === 'unsupported' ? '' : 'error');
    } catch (error) {
      toast(`${item?.name || '上游'} 余额查询失败：${error.message}`, 'error');
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = '查询余额';
      }
    }
  }
  if (button.dataset.action === 'reset-health') {
    button.disabled = true;
    try {
      await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/reset-health`, { method: 'POST', body: '{}' });
      await loadConfig();
      toast(`${item?.name || '上游'} 健康状态已重置`);
    } catch (error) { toast(error.message, 'error'); }
    button.disabled = false;
  }
  if (button.dataset.action === 'test-upstream') {
    button.disabled = true;
    button.textContent = '测试中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/test`, { method: 'POST', body: '{}' });
      toast(`${item.name} 测试成功（HTTP ${result.status}）`);
    } catch (error) { toast(`${item?.name || '上游'} 测试失败：${error.message}`, 'error'); }
    button.disabled = false;
    button.textContent = '测试连接';
  }
  if (button.dataset.action === 'sync-upstream') {
    button.disabled = true;
    button.textContent = '同步中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/sync-models`, { method: 'POST', body: '{}' });
      await loadConfig();
      toast(`${item?.name || '上游'} 已同步 ${result.count} 个模型`);
    } catch (error) { toast(`${item?.name || '上游'} 同步失败：${error.message}`, 'error'); }
    button.disabled = false;
    button.textContent = '同步模型';
  }
  if (button.dataset.action === 'probe-upstream-thinking') {
    button.disabled = true;
    button.textContent = '探测中…';
    try {
      const result = await api(`/api/admin/upstreams/${encodeURIComponent(button.dataset.id)}/thinking-probe`, { method: 'POST', body: '{}' });
      applyThinkingProbeResult(result);
      if (result.status === 'busy') toast(`${item?.name || '上游'} 正在探测中`, 'error');
      else toast(`${item?.name || '上游'} 思考强度探测完成：探测 ${result.probed}（支持 ${result.supported}、不支持 ${result.unsupported}），跳过 ${result.skipped}，失败 ${result.failed}`, result.failed ? 'error' : '');
    } catch (error) { toast(`${item?.name || '上游'} 思考强度探测失败：${error.message}`, 'error'); }
    button.disabled = false;
    button.textContent = '探测思考';
  }
  if (button.dataset.action === 'delete-upstream') await deleteItem('upstreams', button.dataset.id, '上游');
  if (button.dataset.action === 'delete-route') await deleteItem('routes', button.dataset.id, '路由');
  if (button.dataset.action === 'delete-key') await deleteItem('local-keys', button.dataset.id, '本地 Key');
}

async function createKey(event) {
  event.preventDefault();
  try {
    await api('/api/admin/local-keys', { method: 'POST', body: JSON.stringify({ name: $('#keyName').value.trim(), ...keyAccessPayload($('#keyForm')) }) });
    closeDialog($('#keyDialog'));
    $('#keyName').value = '';
    await loadConfig();
    toast('本地 Key 已创建，可在列表中查看或复制');
  } catch (error) { toast(error.message, 'error'); }
}

async function clearMetrics() {
  if (!window.confirm('确定清空所有请求统计和最近日志吗？此操作不可撤销。')) return;
  try {
    state.metrics = await api('/api/admin/metrics', { method: 'DELETE' });
    state.metricsRange = null;
    fillDefaultRangeInputs();
    renderMetrics();
    toast('请求统计已清空');
  } catch (error) { toast(error.message, 'error'); }
}

async function importUsageFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const records = Array.isArray(data) ? data : data?.records;
    if (!Array.isArray(records)) throw new Error('文件不是有效的用量导出文件：缺少 records 数组');
    if (!window.confirm(`确定导入 ${records.length} 条用量记录吗？已有相同请求 ID 的记录会自动跳过。`)) return;
    const result = await api('/api/admin/metrics/import', { method: 'POST', body: JSON.stringify(data) });
    state.metrics = result.metrics;
    renderMetrics();
    toast(`导入完成：新增 ${result.imported} 条，重复 ${result.duplicates} 条，当前保留 ${result.retained} 条`);
  } catch (error) { toast(`导入用量失败：${error.message}`, 'error'); }
}

async function saveSettings() {
  const payload = {
    upstreamTimeoutMs: Number($('#upstreamTimeoutMs').value),
    upstreamRetries: Number($('#upstreamRetries').value),
    maxFallbackAttempts: Number($('#maxFallbackAttempts').value),
    retryDelayMs: Number($('#retryDelayMs').value),
    circuitBreakerFailureThreshold: Number($('#circuitBreakerFailureThreshold').value),
    circuitBreakerCooldownMs: Number($('#circuitBreakerCooldownMs').value),
    maxConcurrentRequests: Number($('#maxConcurrentRequests').value),
    requestsPerMinute: Number($('#requestsPerMinute').value),
    errorPrefix: $('#errorPrefix').value.trim()
  };
  try {
    const settings = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    state.config.settings = settings;
    $('#settingsMessage').textContent = '设置已保存。';
    $('#settingsMessage').className = 'form-message success';
    toast('可靠性设置已保存');
  } catch (error) {
    $('#settingsMessage').textContent = error.message;
    $('#settingsMessage').className = 'form-message error';
  }
}

function renderAdminAuth() {
  const data = state.adminAuth;
  if (!data) return;
  const mode = data.remoteMode === 'password' ? 'password' : 'oidc';
  const radio = document.querySelector(`input[name="adminAuthMode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  const requireCheckbox = $('#adminAuthRequireLocalLogin');
  requireCheckbox.checked = data.requireLocalLogin === true;
  requireCheckbox.disabled = mode !== 'password';
  $('#adminAuthOidcState').textContent = data.oidcConfigured ? '已配置' : '未配置 AUTHENTIK 环境变量';
  $('#adminAuthPasswordState').textContent = (data.users || []).filter((item) => item.enabled).length > 0 ? `已配置 ${(data.users || []).filter((item) => item.enabled).length} 个启用账号` : '尚无启用账号';
  const users = data.users || [];
  $('#adminUserList').innerHTML = users.length ? users.map((item) => `<article class="item-card" data-card-id="${escapeHtml(item.id)}"><div><div class="item-title">${escapeHtml(item.username)}</div><div class="item-meta"><span class="tag ${item.enabled ? 'active' : 'off'}">${item.enabled ? '已启用' : '已停用'}</span>${item.createdAt ? `<span>创建于 ${escapeHtml(new Date(item.createdAt).toLocaleString())}</span>` : ''}${item.updatedAt ? `<span>更新于 ${escapeHtml(new Date(item.updatedAt).toLocaleString())}</span>` : ''}</div></div><div class="item-actions"><button class="text-button" data-action="edit-admin-user" data-id="${escapeHtml(item.id)}">编辑</button><button class="text-button" data-action="toggle-admin-user" data-id="${escapeHtml(item.id)}">${item.enabled ? '停用' : '启用'}</button><button class="text-button delete" data-action="delete-admin-user" data-id="${escapeHtml(item.id)}">删除</button></div></article>`).join('') : '<div class="empty">还没有管理员账号。远程访问会提示先在本机创建账号。</div>';
}

async function saveAdminAuthMode() {
  const mode = document.querySelector('input[name="adminAuthMode"]:checked')?.value || 'oidc';
  const requireLocalLogin = mode === 'password' && $('#adminAuthRequireLocalLogin').checked;
  const message = $('#adminAuthMessage');
  try {
    state.adminAuth = await api('/api/admin/admin-auth/remote-mode', {
      method: 'PUT',
      body: JSON.stringify({ remoteMode: mode, requireLocalLogin })
    });
    renderAdminAuth();
    if (mode === 'password') {
      message.textContent = requireLocalLogin
        ? '已切换到本地账号认证，并开启本机登录：当前页面会立即失效，请用刚才配置的账号重新登录。'
        : '已切换到本地账号认证：远程访问将使用账号密码登录。';
    } else {
      message.textContent = '已切换到外部 OIDC 提供商：远程访问将通过统一登录进入。';
    }
    message.className = 'form-message success';
    toast('远程管理认证方式已保存');
    if (mode === 'password' && requireLocalLogin) {
      setTimeout(() => window.location.replace('/auth/login?returnTo=/'), 1600);
    }
  } catch (error) {
    message.textContent = error.message;
    message.className = 'form-message error';
  }
}

function fillAdminUserForm(item) {
  $('#adminUserId').value = item?.id || '';
  $('#adminUsername').value = item?.username || '';
  $('#adminPassword').value = '';
  $('#adminPassword').required = !item;
  $('#adminUserEnabled').checked = item ? item.enabled !== false : true;
  $('#adminUserDialogTitle').textContent = item ? '编辑管理员账号' : '新建管理员账号';
  openDialog($('#adminUserDialog'));
}

async function saveAdminUser() {
  const id = $('#adminUserId').value;
  const username = $('#adminUsername').value.trim();
  const password = $('#adminPassword').value;
  const enabled = $('#adminUserEnabled').checked;
  const payload = { username, enabled };
  if (password) payload.password = password;
  try {
    if (id) {
      await api(`/api/admin/admin-auth/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('管理员账号已更新');
    } else {
      await api('/api/admin/admin-auth/users', { method: 'POST', body: JSON.stringify(payload) });
      toast('管理员账号已创建');
    }
    closeDialog($('#adminUserDialog'));
    state.adminAuth = await api('/api/admin/admin-auth');
    renderAdminAuth();
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function handleAdminUserClick(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const id = button.dataset.id;
  const user = (state.adminAuth?.users || []).find((item) => item.id === id);
  if (!user) return;
  if (action === 'edit-admin-user') {
    fillAdminUserForm(user);
    return;
  }
  if (action === 'toggle-admin-user') {
    try {
      await api(`/api/admin/admin-auth/users/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ username: user.username, enabled: !user.enabled }) });
      state.adminAuth = await api('/api/admin/admin-auth');
      renderAdminAuth();
      toast(`账号「${user.username}」已${user.enabled ? '停用' : '启用'}`);
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  if (action === 'delete-admin-user') {
    if (!window.confirm(`确定删除账号「${user.username}」吗？`)) return;
    try {
      await api(`/api/admin/admin-auth/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.adminAuth = await api('/api/admin/admin-auth');
      renderAdminAuth();
      toast(`账号「${user.username}」已删除`);
    } catch (error) { toast(error.message, 'error'); }
  }
}

async function exportConfig() {
  try {
    const backup = await api('/api/admin/config/export');
    downloadJson(`Sakura-AI-Gateway-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
    toast('配置已导出，请妥善保存备份文件');
  } catch (error) { toast(error.message, 'error'); }
}

function importConfigFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const backup = JSON.parse(reader.result);
      if (!backup.config && !backup.upstreams) throw new Error('文件不是有效的网关配置备份');
      if (!window.confirm('确定导入这个配置吗？当前的上游和路由会被替换；当前本地 Key 会保留。')) return;
      await api('/api/admin/config/import', { method: 'POST', body: JSON.stringify({ ...backup, preserveCredentials: true }) });
      await loadConfig();
      toast('配置已导入；监听地址或端口变更需要重启服务后生效');
    } catch (error) { toast(`导入失败：${error.message}`, 'error'); }
  };
  reader.readAsText(file);
}

async function checkHealth() {
  try {
    const response = await fetch('/health');
    if (!response.ok) throw new Error('offline');
    $('#healthText').textContent = '服务正常';
    $('.status-dot').classList.add('ok');
  } catch {
    $('#healthText').textContent = '服务异常';
    $('.status-dot').classList.add('error');
  }
}

$('#loadButton').addEventListener('click', loadConfig);
$('#logoutButton').addEventListener('click', () => { window.location.assign('/auth/logout'); });
document.querySelector('.tabs').addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (button) switchTab(button.dataset.tab);
});
$('#addUpstreamButton').addEventListener('click', () => fillUpstreamForm());
$('#addRouteButton').addEventListener('click', () => {
  if (!state.config.upstreams.length) return toast('请先添加至少一个上游站点', 'error');
  fillRouteForm();
});
$('#addKeyButton').addEventListener('click', () => {
  $('#keyForm').reset();
  fillKeyAccessForm($('#keyForm'));
  openDialog($('#keyDialog'));
});
bindKeyAccessForm($('#keyForm'));
bindKeyAccessForm($('#keyEditForm'));
$('#fetchUpstreamModelsButton').addEventListener('click', fetchUpstreamModels);
$('#queryAllBalancesButton').addEventListener('click', queryAllBalances);
$('#upstreamClientIdentityPreset').addEventListener('change', updateClientIdentityFields);
document.querySelectorAll('[data-dialog-close]').forEach((button) => {
  button.addEventListener('click', () => closeDialog(document.getElementById(button.dataset.dialogClose)));
});
$('#upstreamForm').addEventListener('submit', saveUpstream);
$('#routeForm').addEventListener('submit', saveRoute);
$('#keyForm').addEventListener('submit', createKey);
$('#keyEditForm').addEventListener('submit', saveKeyEdit);
$('#upstreamList').addEventListener('click', handleListClick);
$('#routeList').addEventListener('click', handleListClick);
$('#keyList').addEventListener('click', handleListClick);
$('#integrationList').addEventListener('click', handleListClick);
$('#clearMetricsButton').addEventListener('click', clearMetrics);
$('#applyMetricsRangeButton').addEventListener('click', applyMetricsRange);
$('#resetMetricsRangeButton').addEventListener('click', resetMetricsRange);
$('#refreshLogsButton').addEventListener('click', refreshRequestLogs);
$('#requestLogBody').addEventListener('click', (event) => {
  const row = event.target.closest('.log-row-expandable');
  if (!row) return;
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains('log-detail-row')) detail.classList.toggle('hidden');
});
$('#loadMoreLogsButton').addEventListener('click', loadMoreLogs);
$('#exportRecentUsageButton').addEventListener('click', () => exportUsage('recent'));
$('#exportAllUsageButton').addEventListener('click', () => exportUsage('all'));
$('#importUsageButton').addEventListener('click', () => $('#usageFileInput').click());
$('#usageFileInput').addEventListener('change', async (event) => { await importUsageFile(event.target.files[0]); event.target.value = ''; });
$('#importUsageButton').addEventListener('click', () => $('#usageFileInput').click());
$('#usageFileInput').addEventListener('change', async (event) => {
  await importUsageFile(event.target.files[0]);
  event.target.value = '';
});
$('#checkUpdateButton').addEventListener('click', checkForUpdates);
$('#viewChangelogButton')?.addEventListener('click', viewChangelog);
$('#refreshIntegrationsButton')?.addEventListener('click', loadIntegrations);
$('#syncAllModelsButton').addEventListener('click', syncAllModels);
$('#probeThinkingButton').addEventListener('click', probeAllThinking);
$('#saveModelSelectionsButton').addEventListener('click', saveModelSelections);
$('#modelCatalogSearch').addEventListener('input', () => { syncRenderedModelDraft(); renderModelCatalog(); });
$('#showThinkingModelsOnly').addEventListener('change', () => { syncRenderedModelDraft(); renderModelCatalog(); });
$('#expandAllModelsButton').addEventListener('click', () => expandModelGroups(true));
$('#collapseAllModelsButton').addEventListener('click', () => expandModelGroups(false));
$('#modelCatalogList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'toggle-prefix') togglePrefix(button.dataset.prefixKey);
  if (button.dataset.action === 'select-prefix') batchSelectModels(button.dataset.prefix, true);
  if (button.dataset.action === 'clear-prefix') batchSelectModels(button.dataset.prefix, false);
  if (button.dataset.action === 'refresh-capabilities') refreshModelCapabilities(button);
});
$('#modelCatalogList').addEventListener('change', (event) => {
  if (event.target.matches('[data-action="model-upstream"]')) {
    const row = event.target.closest('.model-row');
    const pool = row?.querySelector('[data-role="model-pool"]');
    if (pool) pool.classList.toggle('hidden', event.target.value !== '__auto__');
  }
  syncRenderedModelDraft();
});
$('#modelCatalogList').addEventListener('input', (event) => {
  if (event.target.matches('[data-action="model-alias"]')) syncRenderedModelDraft();
});
$('#saveSettingsButton').addEventListener('click', saveSettings);
$('#saveAdminAuthModeButton').addEventListener('click', saveAdminAuthMode);
document.querySelectorAll('input[name="adminAuthMode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    const checkbox = $('#adminAuthRequireLocalLogin');
    checkbox.disabled = radio.value !== 'password' && radio.checked;
    if (checkbox.disabled) checkbox.checked = false;
  });
});
$('#addAdminUserButton').addEventListener('click', () => fillAdminUserForm());
$('#adminUserForm').addEventListener('submit', saveAdminUser);
$('#adminUserList').addEventListener('click', handleAdminUserClick);
$('#exportConfigButton').addEventListener('click', exportConfig);
$('#importConfigButton').addEventListener('click', () => $('#configFileInput').click());
$('#configFileInput').addEventListener('change', (event) => {
  importConfigFile(event.target.files[0]);
  event.target.value = '';
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'F5') {
    event.preventDefault();
    window.location.reload();
  }
});
checkHealth();
enablePanelDragging();
restoreActiveTab();
initializeAdminAccess();
state.metricsRefreshTimer = window.setInterval(() => refreshMetrics(), 5000);