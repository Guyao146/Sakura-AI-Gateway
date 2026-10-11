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

function emptyMetrics() {
  return {
    version: 1,
    totals: {
      requests: 0,
      successful: 0,
      failed: 0,
      failovers: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    },
    byUpstream: {}
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
    return {
      aggregates: {
        version: 1,
        totals: { ...defaults.totals, ...(parsed.totals || {}) },
        byUpstream: parsed.byUpstream && typeof parsed.byUpstream === 'object' ? parsed.byUpstream : {}
      },
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
  if (Array.isArray(loaded.legacyLogs) && loaded.legacyLogs.length) saveMetrics();
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
  const promptTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const completionTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || promptTokens + completionTokens;
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

// 聚合单条日志到 totals/byUpstream：实时记录与时间范围统计共用同一套语义。
function aggregateInto(state, entry) {
  // 日志里的用量可能已是归一化后的 camelCase（实时记录），也可能来自导入的 snake_case。
  const usage = normalizeUsage({
    prompt_tokens: entry.usage?.prompt_tokens ?? entry.usage?.input_tokens ?? entry.usage?.promptTokens,
    completion_tokens: entry.usage?.completion_tokens ?? entry.usage?.output_tokens ?? entry.usage?.completionTokens,
    total_tokens: entry.usage?.total_tokens ?? entry.usage?.totalTokens
  });
  const attempts = normalizeAttempts(entry.attempts);
  const success = entry.success === true;
  // failover 表示真的换了上游：原地重试同一个站不算切换。
  const failover = entry.failover !== undefined ? entry.failover === true : attempts.length > 1;
  const totals = state.totals;
  totals.requests += 1;
  if (success) totals.successful += 1;
  else totals.failed += 1;
  if (failover) totals.failovers += 1;
  totals.promptTokens += usage.promptTokens;
  totals.completionTokens += usage.completionTokens;
  totals.totalTokens += usage.totalTokens;
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
    model: String(entry.model || '').slice(0, 200),
    upstream: entry.upstream ? String(entry.upstream).slice(0, 120) : null,
    upstreamModel: entry.upstreamModel ? String(entry.upstreamModel).slice(0, 200) : null,
    status: Number.isInteger(entry.status) ? entry.status : 500,
    durationMs: Math.max(0, Math.round(numberOrZero(entry.durationMs))),
    stream: entry.stream === true,
    success,
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
  const chronological = [...logs, ...accepted].sort((a, b) => new Date(a.finishedAt || a.startedAt).getTime() - new Date(b.finishedAt || a.startedAt).getTime()).slice(-MAX_LOGS);
  logs = chronological.slice().reverse();
  metrics = emptyMetrics();
  // 与实时记录共用聚合语义：导入后的 totals/byUpstream 与逐条统计保持一致。
  for (const entry of chronological) aggregateInto(metrics, entry);
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
    byUpstream: Object.fromEntries(Object.entries(state.byUpstream).map(([name, value]) => [name, { ...value }]))
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

function getAllLogs() {
  return logs.slice().reverse().map(cloneLog);
}

function getMetrics(options = {}) {
  const logPage = getLogs(options);
  return {
    version: metrics.version,
    totals: { ...metrics.totals },
    byUpstream: Object.fromEntries(Object.entries(metrics.byUpstream).map(([name, value]) => [name, { ...value }])),
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
  getAllLogs,
  getRangeStats,
  importUsageRecords,
  clearMetrics
};