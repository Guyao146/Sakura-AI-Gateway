const fs = require('node:fs');
const path = require('node:path');

// 与配置读取保持一致：新名称优先，旧变量仅用于升级兼容。
const DATA_DIR = (process.env.SAKURA_AI_GATEWAY_DATA_DIR ?? process.env.LOCAL_MODEL_GATEWAY_DATA_DIR) || path.join(__dirname, '..', 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const LOG_PATH = path.join(DATA_DIR, 'metrics-log.jsonl');
const parsedMaxLogs = Number(process.env.SAKURA_AI_GATEWAY_MAX_LOGS ?? process.env.LOCAL_MODEL_GATEWAY_MAX_LOGS);
const MAX_LOGS = Number.isFinite(parsedMaxLogs) && parsedMaxLogs >= 100 ? Math.floor(parsedMaxLogs) : 5000;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;
const MAX_ATTEMPTS_PER_LOG = 12;
// 客户端请求内容的可搜索摘要长度：只保留最后一条用户消息的截断文本。
const MAX_CONTENT_DIGEST = 500;

function emptyCounters() {
  return {
    requests: 0,
    successful: 0,
    failed: 0,
    failovers: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };
}

function emptyMetrics() {
  return {
    version: 1,
    totals: emptyCounters(),
    byUpstream: {},
    // 空字符串专门表示未归属 Key；无原型字典也能安全处理导入的特殊 ID。
    byKey: Object.create(null)
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
}

// Aggregated counters live in metrics.json; individual request logs live in an
// append-only JSONL file so we can keep thousands of entries without rewriting a
// large JSON document on every request.
function loadMetrics() {
  ensureDataDir();
  const defaults = emptyMetrics();
  if (!fs.existsSync(METRICS_PATH)) return { aggregates: defaults, legacyLogs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    const hasKeyMetrics = parsed.byKey && typeof parsed.byKey === 'object' && !Array.isArray(parsed.byKey);
    return {
      aggregates: {
        version: 1,
        totals: { ...defaults.totals, ...(parsed.totals || {}) },
        byUpstream: parsed.byUpstream && typeof parsed.byUpstream === 'object' ? parsed.byUpstream : {},
        byKey: hasKeyMetrics ? Object.assign(Object.create(null), parsed.byKey) : Object.create(null)
      },
      needsKeyMigration: !hasKeyMetrics,
      // Older builds stored logs inline; migrate them into the JSONL file.
      legacyLogs: Array.isArray(parsed.logs) ? parsed.logs : []
    };
  } catch {
    // A corrupted metrics file should not prevent the gateway from starting.
    return { aggregates: defaults, legacyLogs: [] };
  }
}

function parseLogLines(raw) {
  const parsed = [];
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      // Skip a single corrupted line instead of dropping the whole history.
    }
  }
  return parsed;
}

function writeLogFile(chronologicalEntries) {
  ensureDataDir();
  const tempPath = `${LOG_PATH}.tmp`;
  const body = chronologicalEntries.map((entry) => JSON.stringify(entry)).join('\n');
  fs.writeFileSync(tempPath, body ? `${body}\n` : '', { mode: 0o600 });
  fs.renameSync(tempPath, LOG_PATH);
  try {
    fs.chmodSync(LOG_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function loadLogs(legacyLogs) {
  ensureDataDir();
  if (!fs.existsSync(LOG_PATH)) {
    // Migrate inline logs (stored newest-first) into a chronological JSONL file.
    const chronological = Array.isArray(legacyLogs) ? [...legacyLogs].reverse() : [];
    if (chronological.length) writeLogFile(chronological.slice(-MAX_LOGS));
    const migrated = chronological.slice(-MAX_LOGS).reverse();
    return { logs: migrated, fileLines: Math.min(chronological.length, MAX_LOGS) };
  }
  try {
    const parsed = parseLogLines(fs.readFileSync(LOG_PATH, 'utf8'));
    const recent = parsed.slice(-MAX_LOGS);
    return { logs: recent.slice().reverse(), fileLines: parsed.length };
  } catch {
    return { logs: [], fileLines: 0 };
  }
}

const loaded = loadMetrics();
let metrics = loaded.aggregates;
// In-memory cache of the most recent entries, newest first.
let logs = [];
let logFileLines = 0;

(function initLogs() {
  const state = loadLogs(loaded.legacyLogs);
  logs = state.logs;
  logFileLines = state.fileLines;
  if (loaded.needsKeyMigration) migrateKeyMetrics();
  if (loaded.needsKeyMigration || (Array.isArray(loaded.legacyLogs) && loaded.legacyLogs.length)) saveMetrics();
}());

function saveMetrics() {
  ensureDataDir();
  const tempPath = `${METRICS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(metrics, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, METRICS_PATH);
  try {
    fs.chmodSync(METRICS_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function appendLog(entry) {
  ensureDataDir();
  fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  logFileLines += 1;
  // Compact the file occasionally so it never grows without bound.
  if (logFileLines > MAX_LOGS * 2) {
    writeLogFile(logs.slice(0, MAX_LOGS).slice().reverse());
    logFileLines = Math.min(logs.length, MAX_LOGS);
  }
}

function normalizeUsage(usage = {}) {
  if (!usage || typeof usage !== 'object') usage = {};
  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens);
  const totalTokens = numberOrZero(usage.total_tokens ?? usage.totalTokens) || promptTokens + completionTokens;
  return { promptTokens, completionTokens, totalTokens };
}

function normalizeAttempts(attempts) {
  if (!Array.isArray(attempts)) return [];
  return attempts.slice(0, MAX_ATTEMPTS_PER_LOG).map((attempt) => {
    const item = {
      upstream: String(attempt.upstream || '未知上游').slice(0, 120),
      status: Number.isInteger(attempt.status) ? attempt.status : null
    };
    // retry 是同一上游的第几次原地重试（0 = 首次），用来还原「重试→切换」的顺序。
    const retry = Number(attempt.retry);
    if (Number.isInteger(retry) && retry > 0) item.retry = retry;
    // HTTP 2xx 但返回错误体的尝试由网关标记为失败，导入时不能按状态码重新算成成功。
    if (attempt.outcome === 'failure') item.outcome = 'failure';
    if (typeof attempt.fallback === 'string' && attempt.fallback) item.fallback = attempt.fallback.slice(0, 60);
    if (['openai', 'responses', 'anthropic'].includes(attempt.protocol)) item.protocol = attempt.protocol;
    const error = normalizeErrorDetails(attempt.error);
    if (error) item.error = error;
    return item;
  });
}

// 上游返回错误的结构化摘要（状态码 / code / type / param / 信息）。
// 只保留上游真正提供的字段并统一截断，避免单条日志膨胀。
function normalizeErrorDetails(error) {
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const result = {};
  if (Number.isInteger(error.status)) result.status = error.status;
  if (error.code !== undefined && error.code !== null) result.code = String(error.code).slice(0, 120);
  if (error.type !== undefined && error.type !== null) result.type = String(error.type).slice(0, 120);
  if (error.param !== undefined && error.param !== null) result.param = String(error.param).slice(0, 120);
  if (typeof error.message === 'string' && error.message.length > 0) result.message = error.message.slice(0, 300);
  return Object.keys(result).length > 0 ? result : undefined;
}

// 请求诊断：记录发往上游的请求体与上游/客户端的帧样本，用于排查协议转换问题。
// 每个字段都做截断，保证日志文件不会因此膨胀。
function normalizeDiagnostics(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const pickList = (list) => (Array.isArray(list) ? list.map((item) => String(item).slice(0, 1000)).slice(0, 12) : []);
  const result = {
    upstreamPath: String(diag.upstreamPath || '').slice(0, 200),
    nativeResponses: Boolean(diag.nativeResponses),
    responsesMode: String(diag.responsesMode || '').slice(0, 30),
    upstreamRequest: String(diag.upstreamRequest || '').slice(0, 2000),
    upstreamResponse: pickList(diag.upstreamResponse),
    output: pickList(diag.output),
    warnings: Array.isArray(diag.warnings) ? diag.warnings.map((item) => String(item).slice(0, 300)).slice(0, 10) : []
  };
  const hasContent = result.upstreamRequest
    || result.upstreamResponse.length
    || result.output.length
    || result.warnings.length;
  return hasContent ? result : null;
}

function aggregateKeyInto(byKey, entry, counters) {
  const keyId = entry.keyId ? String(entry.keyId).slice(0, 60) : '';
  const item = byKey[keyId] || { keyId: keyId || null, keyName: '', ...emptyCounters(), lastRequestAt: null };
  for (const field of Object.keys(emptyCounters())) item[field] += counters[field];
  const time = logEntryTime(entry);
  const latest = Number.isFinite(time) && (!item.lastRequestAt || time >= Date.parse(item.lastRequestAt));
  if (keyId && entry.keyName && (!item.keyName || latest)) item.keyName = String(entry.keyName).slice(0, 100);
  if (latest) item.lastRequestAt = new Date(time).toISOString();
  byKey[keyId] = item;
}

// 升级时只用仍保留的明细恢复 Key 归属，不重置原有全量计数。
function migrateKeyMetrics() {
  const recovered = emptyMetrics();
  for (const entry of logs.slice().reverse()) aggregateInto(recovered, entry);
  const fields = Object.keys(emptyCounters());
  // 聚合与明细不一致时不能猜测归属，保守地将原有计数标为未归属。
  const consistent = fields.every((field) => recovered.totals[field] <= numberOrZero(metrics.totals[field]));
  metrics.byKey = consistent ? recovered.byKey : Object.create(null);
  const remainder = Object.fromEntries(fields.map((field) => [field,
    numberOrZero(metrics.totals[field]) - (consistent ? recovered.totals[field] : 0)
  ]));
  if (Object.values(remainder).some((value) => value > 0)) aggregateKeyInto(metrics.byKey, {}, remainder);
}

function cloneKeyMetrics(byKey) {
  return Object.fromEntries(Object.entries(byKey).map(([keyId, item]) => [keyId, { ...item }]));
}

// 聚合单条日志到 totals/byUpstream/byKey：实时记录、导入与时间范围共用同一套语义。
function aggregateInto(state, entry) {
  const usage = normalizeUsage(entry.usage);
  const attempts = normalizeAttempts(entry.attempts);
  const success = entry.success === true;
  // failover 表示真的换了上游：原地重试同一个站不算切换。
  const failover = entry.failover !== undefined ? entry.failover === true : new Set(attempts.map((attempt) => attempt.upstream)).size > 1;
  const totals = state.totals;
  totals.requests += 1;
  if (success) totals.successful += 1;
  else totals.failed += 1;
  if (failover) totals.failovers += 1;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
  // 一条模型请求只计一次；同一请求的重试、故障转移不能重复累计 Key 用量。
  aggregateKeyInto(state.byKey, entry, {
    requests: 1, successful: success ? 1 : 0, failed: success ? 0 : 1,
    failovers: failover ? 1 : 0, ...usage
  });
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const item = state.byUpstream[attempt.upstream] || {
      requests: 0,
      successful: 0,
      failed: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };
    item.requests += 1;
    // HTTP 2xx 但返回错误体的尝试标记了 outcome='failure'，不能按状态码算成功。
    const succeeded = attempt.outcome === 'failure' ? false
      : attempt.status !== null && attempt.status >= 200 && attempt.status < 400;
    if (succeeded) item.successful += 1;
    else item.failed += 1;
    // 用量只归属该上游的最后一次尝试（通常是成功的那次），不能按尝试次数重复累计。
    if (index === attempts.map((entry) => entry.upstream).lastIndexOf(entry.upstream)) {
      item.promptTokens += usage.promptTokens;
      item.completionTokens += usage.completionTokens;
      item.totalTokens += usage.totalTokens;
    }
    state.byUpstream[attempt.upstream] = item;
  }
}

function recordRequest(entry) {
  const success = entry.success === true;
  const upstreamError = normalizeErrorDetails(entry.upstreamError);
  const logEntry = {
    id: String(entry.id || `req_${Date.now()}`),
    startedAt: entry.startedAt || new Date().toISOString(),
    finishedAt: entry.finishedAt || new Date().toISOString(),
    protocol: ['anthropic', 'responses'].includes(entry.protocol) ? entry.protocol : 'openai',
    strategy: ['failover', 'round_robin', 'random', 'weighted'].includes(entry.strategy) ? entry.strategy : 'failover',
    ...(entry.keyId ? { keyId: String(entry.keyId).slice(0, 60) } : {}),
    ...(entry.keyName ? { keyName: String(entry.keyName).slice(0, 100) } : {}),
    model: String(entry.model || '').slice(0, 200),
    upstream: entry.upstream ? String(entry.upstream).slice(0, 120) : null,
    upstreamModel: entry.upstreamModel ? String(entry.upstreamModel).slice(0, 200) : null,
    status: Number.isInteger(entry.status) ? entry.status : 500,
    durationMs: Math.max(0, Math.round(numberOrZero(entry.durationMs))),
    stream: entry.stream === true,
    success,
    ...(typeof entry.contentDigest === 'string' && entry.contentDigest.trim()
      ? { contentDigest: entry.contentDigest.trim().slice(0, MAX_CONTENT_DIGEST) }
      : {}),
    // failover 表示真的换了上游：原地重试同一个站不算切换。
    failover: new Set((Array.isArray(entry.attempts) ? entry.attempts : []).map((attempt) => attempt.upstream)).size > 1,
    attempts: normalizeAttempts(entry.attempts),
    usage: normalizeUsage(entry.usage),
    ...(entry.error ? { error: String(entry.error).slice(0, 500) } : {}),
    ...(upstreamError ? { upstreamError } : {}),
    ...(normalizeDiagnostics(entry.diag) ? { diagnostics: normalizeDiagnostics(entry.diag) } : {})
  };

  aggregateInto(metrics, logEntry);

  logs.unshift(logEntry);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  appendLog(logEntry);
  saveMetrics();
  return logEntry;
}

function normalizeImportedLog(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Object.assign(new Error('用量记录格式无效'), { statusCode: 400 });
  const id = String(entry.id || '').trim();
  if (!id || id.length > 120) throw Object.assign(new Error('用量记录缺少有效的请求 ID'), { statusCode: 400 });
  const normalized = { ...entry, id, usage: normalizeUsage(entry.usage), attempts: normalizeAttempts(entry.attempts) };
  for (const [field, limit] of [['keyId', 60], ['keyName', 100]]) {
    if (entry[field]) normalized[field] = String(entry[field]).slice(0, limit);
    else delete normalized[field];
  }
  if (typeof normalized.contentDigest === 'string' && normalized.contentDigest.trim()) {
    normalized.contentDigest = normalized.contentDigest.trim().slice(0, MAX_CONTENT_DIGEST);
  } else {
    delete normalized.contentDigest;
  }
  const importedUpstreamError = normalizeErrorDetails(entry.upstreamError);
  if (importedUpstreamError) normalized.upstreamError = importedUpstreamError;
  return normalized;
}

function cloneLog(entry) {
  return {
    ...entry,
    attempts: Array.isArray(entry.attempts) ? entry.attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.error ? { error: { ...attempt.error } } : {})
    })) : [],
    usage: { ...(entry.usage || {}) },
    ...(entry.upstreamError ? { upstreamError: { ...entry.upstreamError } } : {})
  };
}

function importUsageRecords(records) {
  if (!Array.isArray(records)) throw Object.assign(new Error('用量文件缺少 records 数组'), { statusCode: 400 });
  const existingIds = new Set(logs.map((entry) => entry.id));
  const importedIds = new Set();
  const accepted = [];
  let duplicates = 0;
  for (const raw of records) {
    const entry = normalizeImportedLog(raw);
    if (existingIds.has(entry.id) || importedIds.has(entry.id)) { duplicates += 1; continue; }
    importedIds.add(entry.id);
    accepted.push(entry);
  }
  const chronological = [...logs, ...accepted].sort((a, b) => logEntryTime(a) - logEntryTime(b)).slice(-MAX_LOGS);
  logs = chronological.slice().reverse();
  // 只累计新增记录，不能因明细已裁剪而丢失已有全量计数。
  for (const entry of accepted) aggregateInto(metrics, entry);
  writeLogFile(chronological);
  logFileLines = chronological.length;
  saveMetrics();
  return { imported: accepted.length, duplicates, retained: logs.length, metrics: getMetrics() };
}

// 按时间范围统计明细日志：闭区间 [from, to]，与实时统计使用同一套聚合语义。
function getRangeStats({ from, to } = {}) {
  const start = Date.parse(String(from ?? ''));
  const end = Date.parse(String(to ?? ''));
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw Object.assign(new Error('时间范围参数无效：需要有效的 from 与 to'), { statusCode: 400 });
  }
  if (start > end) {
    throw Object.assign(new Error('时间范围的开始时间不能晚于结束时间'), { statusCode: 400 });
  }
  const state = emptyMetrics();
  let matched = 0;
  for (const entry of logs) {
    const time = Date.parse(entry.finishedAt || entry.startedAt);
    if (!Number.isFinite(time) || time < start || time > end) continue;
    matched += 1;
    aggregateInto(state, entry);
  }
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    matched,
    totals: { ...state.totals },
    byUpstream: Object.fromEntries(Object.entries(state.byUpstream).map(([name, value]) => [name, { ...value }])),
    byKey: cloneKeyMetrics(state.byKey)
  };
}

function normalizeLimit(value) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(parsed, MAX_LOG_LIMIT);
}

function normalizeOffset(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getLogs({ limit, offset } = {}) {
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const slice = logs.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  return {
    items: slice.map(cloneLog),
    limit: normalizedLimit,
    offset: normalizedOffset,
    total: logs.length,
    hasMore: normalizedOffset + slice.length < logs.length,
    maxLogs: MAX_LOGS
  };
}

// 单条日志的可搜索文本：覆盖请求 ID、模型、上游、Key 名称、错误、内容摘要与每次尝试的错误码。
function logEntrySearchText(entry) {
  const parts = [entry.id, entry.model, entry.upstreamModel, entry.upstream, entry.keyName, entry.error, entry.contentDigest];
  for (const attempt of Array.isArray(entry.attempts) ? entry.attempts : []) {
    if (!attempt) continue;
    const attemptParts = [attempt.upstream, attempt.error?.code, attempt.error?.type, attempt.error?.message];
    parts.push(attemptParts.filter((value) => typeof value === 'string' && value).join(' '));
  }
  return parts.filter((value) => typeof value === 'string' && value).join('\n').toLowerCase();
}

function logEntryTime(entry) {
  const time = Date.parse(entry.finishedAt || entry.startedAt);
  return Number.isFinite(time) ? time : NaN;
}

function normalizeKeyword(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text.length > 200 ? text.slice(0, 200) : text;
}

// 请求日志的统一筛选核心：关键字、Key 与时间段可任意组合，时间段为闭区间。
function filterRequestLog(entries, { keyword, keyId, from, to } = {}) {
  const needle = normalizeKeyword(keyword);
  const keyFilter = keyId === undefined || keyId === null ? '' : String(keyId);
  const hasFrom = from !== undefined && from !== null && from !== '';
  const hasTo = to !== undefined && to !== null && to !== '';
  const startTime = hasFrom ? Date.parse(String(from)) : null;
  const endTime = hasTo ? Date.parse(String(to)) : null;
  if (hasFrom && !Number.isFinite(startTime)) {
    throw Object.assign(new Error('日志筛选的开始时间无效'), { statusCode: 400 });
  }
  if (hasTo && !Number.isFinite(endTime)) {
    throw Object.assign(new Error('日志筛选的结束时间无效'), { statusCode: 400 });
  }
  if (startTime !== null && endTime !== null && startTime > endTime) {
    throw Object.assign(new Error('日志筛选的开始时间不能晚于结束时间'), { statusCode: 400 });
  }
  return entries.filter((entry) => {
    if (keyFilter && (entry.keyId || '') !== keyFilter) return false;
    const time = logEntryTime(entry);
    if (startTime !== null && Number.isFinite(time) && time < startTime) return false;
    if (endTime !== null && Number.isFinite(time) && time > endTime) return false;
    if (needle && !logEntrySearchText(entry).includes(needle)) return false;
    return true;
  });
}

// 按关键字 / Key / 时间段搜索请求日志，分页口径与 getLogs 一致（最新在前）。
function searchLogs({ keyword, keyId, from, to, limit, offset } = {}) {
  const filtered = filterRequestLog(logs, { keyword, keyId, from, to });
  const normalizedLimit = normalizeLimit(limit);
  const normalizedOffset = normalizeOffset(offset);
  const slice = filtered.slice(normalizedOffset, normalizedOffset + normalizedLimit);
  return {
    items: slice.map(cloneLog),
    limit: normalizedLimit,
    offset: normalizedOffset,
    total: filtered.length,
    hasMore: normalizedOffset + slice.length < filtered.length,
    maxLogs: MAX_LOGS,
    filters: {
      keyword: normalizeKeyword(keyword),
      keyId: keyId === undefined || keyId === null ? null : String(keyId),
      from: hasFromValue(from) ? new Date(Date.parse(String(from))).toISOString() : null,
      to: hasFromValue(to) ? new Date(Date.parse(String(to))).toISOString() : null
    }
  };
}

function hasFromValue(value) {
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Date.parse(String(value)));
}

// 供日志筛选下拉框使用：近期日志里出现过的 Key 及其请求次数。
function listLogKeys() {
  const map = new Map();
  for (const entry of logs) {
    if (!entry.keyId) continue;
    if (!map.has(entry.keyId)) {
      map.set(entry.keyId, { keyId: entry.keyId, keyName: entry.keyName || '', requests: 0 });
    }
    const item = map.get(entry.keyId);
    item.requests += 1;
    if (!item.keyName && entry.keyName) item.keyName = entry.keyName;
  }
  return Array.from(map.values()).sort((a, b) => b.requests - a.requests || a.keyId.localeCompare(b.keyId));
}

function getAllLogs() {
  return logs.slice().reverse().map(cloneLog);
}

function getMetrics(options = {}) {
  const logPage = getLogs(options);
  return {
    version: metrics.version,
    totals: { ...metrics.totals },
    byUpstream: Object.fromEntries(Object.entries(metrics.byUpstream).map(([name, value]) => [name, { ...value }])),
    byKey: cloneKeyMetrics(metrics.byKey),
    logs: logPage.items,
    logPage: {
      limit: logPage.limit,
      offset: logPage.offset,
      total: logPage.total,
      hasMore: logPage.hasMore,
      maxLogs: logPage.maxLogs
    }
  };
}

function clearMetrics() {
  metrics = emptyMetrics();
  logs = [];
  logFileLines = 0;
  writeLogFile([]);
  saveMetrics();
  return getMetrics();
}

module.exports = {
  METRICS_PATH,
  LOG_PATH,
  recordRequest,
  getMetrics,
  getLogs,
  searchLogs,
  listLogKeys,
  getAllLogs,
  getRangeStats,
  importUsageRecords,
  clearMetrics
};