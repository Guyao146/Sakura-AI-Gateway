function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(body, fallback = '上游请求失败') {
  const messages = [body?.error?.message, body?.response?.error?.message, body?.message, body?.error, body?.response?.error, body];
  return messages.find((message) => typeof message === 'string' && message.length > 0) ?? fallback;
}

function upstreamCode(body) {
  const codes = [body?.error?.code, body?.response?.error?.code, body?.code];
  for (const code of codes) {
    if (typeof code === 'string' && code.trim()) return code.trim();
    if (typeof code === 'number' && Number.isFinite(code)) return String(code);
  }
  return undefined;
}

function httpStatusCode(status) {
  const httpStatus = Number(status);
  return Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? String(httpStatus) : '502';
}

function errorCode(body, status) {
  // type 是协议错误类别，不充当错误码；0 也是有效的上游 code。
  return upstreamCode(body) ?? httpStatusCode(status);
}

function isErrorPayload(body, eventName = '') {
  if (!isObject(body)) return false;
  return Boolean(body.error || body.response?.error)
    || body.type === 'error' || eventName === 'error'
    || body.type === 'response.failed' || eventName === 'response.failed'
    || body.status === 'failed' || body.response?.status === 'failed';
}

function formatErrorMessage(message, { prefix = '', requestId, code }) {
  const context = `[request_id=${requestId}] [code=${code}]`;
  const label = prefix ? `${prefix} ` : '';
  let text = String(message ?? '');
  const header = `${label}${context}`;
  if (text === header || text.startsWith(`${header} `)) return text;
  // 兼容已加过前缀的错误，避免 JSON/流式出口重复装饰同一条消息。
  if (prefix && (text === prefix || text.startsWith(label))) text = text.slice(label.length);
  if (text === context || text.startsWith(`${context} `)) return `${label}${text}`;
  return `${header}${text ? ` ${text}` : ''}`;
}

function formatErrorPayload(body, { prefix = '', requestId, status, eventName = '' }) {
  const source = isObject(body) ? body : { message: errorMessage(body) };
  const fallback = Number(status) >= 400 ? `上游返回 HTTP ${status}` : '上游请求失败';
  const message = formatErrorMessage(errorMessage(source, fallback), {
    prefix, requestId, code: errorCode(source, status)
  });
  // 仅拷贝错误所在层：保留 Responses 的 response.failed 和顶层 error 事件形态。
  let result;
  if (source.error !== undefined && source.error !== null) {
    result = { ...source, error: { ...(isObject(source.error) ? source.error : {}), message } };
  } else if (isObject(source.response) && (source.response.error || source.response.status === 'failed'
    || source.type === 'response.failed' || eventName === 'response.failed')) {
    result = { ...source, response: { ...source.response, error: { ...(isObject(source.response.error) ? source.response.error : {}), message } } };
  } else {
    result = { ...source, message };
  }
  // request_id 属于当前网关请求，不能被上游自己的追踪 ID 覆盖。
  return { ...result, request_id: requestId };
}

// 请求日志用：把上游返回的错误体归一成 { status, code, type, param, message }。
// code/type/param 只取上游真正提供的值（HTTP 状态码由调用方单独传入 status），
// 这样日志里能区分「上游返回了什么」与「网关兜底推断的码」。
function upstreamErrorDetails(body, status) {
  const statusValue = Number(status);
  const hasStatus = Number.isInteger(statusValue);
  if (!isObject(body)) {
    if (!hasStatus) return null;
    return typeof body === 'string' && body.trim() ? { status: statusValue, message: body.trim() } : { status: statusValue };
  }
  const error = isObject(body.error) ? body.error : isObject(body.response?.error) ? body.response.error : null;
  const code = upstreamCode(body);
  const type = error?.type ?? (typeof body.type === 'string' && body.type !== 'error' ? body.type : undefined);
  const param = error?.param ?? body.param;
  const message = errorMessage(body, '');
  const result = {};
  if (hasStatus) result.status = statusValue;
  if (code !== undefined) result.code = code;
  if (typeof type === 'string' && type) result.type = type;
  if (param !== undefined && param !== null) result.param = param;
  if (message) result.message = message;
  return Object.keys(result).length ? result : null;
}

// 所有上游都失败时，把「依次试了哪些站、各几次」追加到错误信息末尾，
// 让客户端知道失败发生在重试/切换的哪一步。只覆盖 message：
// code/type/param 等结构化字段保持原值，不影响已有的错误装饰逻辑。
function appendRetrySummary(body, summary) {
  if (!summary) return body;
  const base = errorMessage(body, '');
  const message = base ? `${base}（${summary}）` : summary;
  if (!isObject(body)) return { message };
  if (isObject(body.error)) return { ...body, error: { ...body.error, message } };
  return { ...body, message };
}

const ANTHROPIC_ERROR_TYPES = new Set([
  'invalid_request_error', 'authentication_error', 'billing_error', 'permission_error', 'not_found_error',
  'conflict_error', 'request_too_large', 'rate_limit_error', 'api_error', 'timeout_error', 'overloaded_error'
]);

function anthropicErrorType(status) {
  const types = { 401: 'authentication_error', 402: 'billing_error', 403: 'permission_error', 404: 'not_found_error',
    409: 'conflict_error', 413: 'request_too_large', 429: 'rate_limit_error', 504: 'timeout_error', 529: 'overloaded_error' };
  return types[status] || (Number(status) >= 400 && Number(status) < 500 ? 'invalid_request_error' : 'api_error');
}

function errorForProtocol(localProtocol, body, status) {
  const source = isObject(body) ? body : {};
  const details = isObject(source.error) ? source.error
    : isObject(source.response?.error) ? source.response.error
      : {
          ...(source.code !== undefined ? { code: source.code } : {}),
          ...(source.param !== undefined ? { param: source.param } : {}),
          ...(source.type && source.type !== 'error' ? { type: source.type } : {})
        };
  const error = { ...details, message: errorMessage(body, `上游返回 HTTP ${status}`) };
  if (localProtocol === 'anthropic') {
    const type = ANTHROPIC_ERROR_TYPES.has(error.type) ? error.type : anthropicErrorType(status);
    return { ...(source.error ? source : {}), type: 'error', error: { ...error,
      ...(error.type && error.type !== type ? { upstream_type: error.type } : {}), type } };
  }
  return source.error ? { ...source, error } : { error: { type: 'upstream_error', ...error } };
}

function streamErrorForProtocol(localProtocol, body, status = 502) {
  const payload = errorForProtocol(localProtocol, body, status);
  if (localProtocol !== 'responses') return payload;
  // Responses SSE 的 error 事件使用顶层 code/message，而不是 Chat 的 error 对象。
  return {
    ...payload.error,
    type: 'error',
    code: payload.error.code ?? errorCode(body, status),
    param: payload.error.param ?? null
  };
}

module.exports = {
  errorMessage,
  errorCode,
  isErrorPayload,
  formatErrorMessage,
  formatErrorPayload,
  errorForProtocol,
  streamErrorForProtocol,
  appendRetrySummary,
  upstreamErrorDetails
};