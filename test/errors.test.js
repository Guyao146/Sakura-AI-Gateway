const assert = require('node:assert/strict');
const {
  errorMessage,
  errorCode,
  isErrorPayload,
  formatErrorMessage,
  formatErrorPayload,
  errorForProtocol,
  streamErrorForProtocol,
  appendRetrySummary,
  upstreamErrorDetails
} = require('../src/errors');

const context = { prefix: '[TestGateway]', requestId: 'req_test', status: 429 };
const source = Object.freeze({
  request_id: 'upstream_request',
  error: Object.freeze({ message: '配额不足\n请稍后重试', code: 'quota_exceeded', type: 'rate_limit_error', param: null }),
  extra: 'preserved'
});
const formatted = formatErrorPayload(source, context);
assert.deepEqual(formatted, {
  ...source,
  request_id: 'req_test',
  error: { ...source.error, message: '[TestGateway] [request_id=req_test] [code=quota_exceeded] 配额不足\n请稍后重试' }
});
assert.equal(source.error.message, '配额不足\n请稍后重试');
assert.equal(source.request_id, 'upstream_request');
assert.deepEqual(formatErrorPayload(formatted, context), formatted, '重复格式化不能重复前缀或请求信息');
assert.equal(formatErrorMessage('[TestGateway] already prefixed', { ...context, code: '502' }),
  '[TestGateway] [request_id=req_test] [code=502] already prefixed');
assert.equal(formatErrorMessage('[request_id=req_test] [code=502] original', { ...context, code: '502' }),
  '[TestGateway] [request_id=req_test] [code=502] original');
assert.equal(formatErrorMessage('original', { prefix: '', requestId: 'req_test', code: '400' }),
  '[request_id=req_test] [code=400] original');

for (const [body, status, expected] of [
  [{ error: { code: 'quota', type: 'rate_limit_error' }, code: 'outer' }, 429, 'quota'],
  [{ error: { code: 0 } }, 400, '0'],
  [{ error: { code: 123 } }, 400, '123'],
  [{ response: { error: { code: 'server_error' } } }, 200, 'server_error'],
  [{ code: 'top_level' }, 200, 'top_level'],
  [{ error: { code: null }, code: 'outer' }, 400, 'outer'],
  [{ error: { code: '', type: 'authentication_error' } }, 401, '401'],
  [{ error: { code: '   ' } }, 404, '404'],
  [{ error: { code: false } }, 400, '400'],
  [{ error: { code: {} } }, 503, '503'],
  [{ error: { type: 'overloaded_error' } }, 200, '502'],
  [null, undefined, '502']
]) assert.equal(errorCode(body, status), expected);

assert.equal(errorMessage({ error: 'string error' }), 'string error');
assert.equal(errorMessage('text error'), 'text error');
assert.equal(errorMessage({ response: { error: { message: 'failed response' } } }), 'failed response');
assert.equal(errorMessage(null, 'fallback'), 'fallback');
for (const body of [source, { type: 'error', message: 'failed' }, { type: 'response.failed' }, { response: { status: 'failed' } }]) {
  assert.equal(isErrorPayload(body), true);
}
assert.equal(isErrorPayload({ message: 'failed' }, 'error'), true);
for (const body of [null, 'text', { error: null }, { type: 'response.completed', response: { error: null, status: 'completed' } }, { choices: [] }]) {
  assert.equal(isErrorPayload(body), false);
}

const nativeFailure = {
  type: 'response.failed', sequence_number: 7,
  response: { id: 'resp_not_request_id', status: 'failed', output: [], error: { code: 'server_error', message: 'failed response' } }
};
const nativeFormatted = formatErrorPayload(nativeFailure, { ...context, status: 200 });
assert.equal(nativeFormatted.type, 'response.failed');
assert.equal(nativeFormatted.sequence_number, 7);
assert.equal(nativeFormatted.response.id, 'resp_not_request_id');
assert.equal(nativeFormatted.response.error.code, 'server_error');
assert.equal(nativeFormatted.response.error.message, '[TestGateway] [request_id=req_test] [code=server_error] failed response');
assert.equal(nativeFailure.response.error.message, 'failed response');
assert.deepEqual(formatErrorPayload(nativeFormatted, { ...context, status: 200 }), nativeFormatted);

const flatError = { type: 'error', code: 'invalid_request', message: 'bad parameter', param: 'model', sequence_number: 1 };
const flatFormatted = formatErrorPayload(flatError, context);
assert.equal(flatFormatted.error, undefined);
assert.equal(flatFormatted.message, '[TestGateway] [request_id=req_test] [code=invalid_request] bad parameter');
assert.equal(flatFormatted.param, 'model');
assert.equal(flatFormatted.sequence_number, 1);

for (const [body, status, expected] of [
  [source, 429, { status: 429, code: 'quota_exceeded', type: 'rate_limit_error', message: '配额不足\n请稍后重试' }],
  [flatError, 400, { status: 400, code: 'invalid_request', param: 'model', message: 'bad parameter' }],
  [{ error: { code: 0, message: 'numeric zero' } }, 400, { status: 400, code: '0', message: 'numeric zero' }],
  [nativeFailure, 200, { status: 200, code: 'server_error', type: 'response.failed', message: 'failed response' }],
  [{ error: 'string error' }, 400, { status: 400, message: 'string error' }],
  [null, 503, { status: 503 }],
  [null, 200, { status: 200 }],
  [undefined, undefined, null]
]) assert.deepEqual(upstreamErrorDetails(body, status), expected, '上游错误应只保留实际提供的字段');

for (const protocol of ['openai', 'responses', 'anthropic']) {
  const converted = errorForProtocol(protocol, source, 429);
  assert.deepEqual(converted.error, source.error);
  assert.equal(converted.extra, 'preserved');
  if (protocol === 'anthropic') assert.equal(converted.type, 'error');
  const textError = errorForProtocol(protocol, 'unavailable', 502);
  assert.equal(textError.error.message, 'unavailable');
  assert.equal(textError.error.type, protocol === 'anthropic' ? 'api_error' : 'upstream_error');
  const nativeConverted = errorForProtocol(protocol, nativeFailure, 502);
  assert.equal(nativeConverted.error.message, 'failed response');
  assert.equal(nativeConverted.error.code, 'server_error');
}
assert.deepEqual(streamErrorForProtocol('responses', source), {
  type: 'error', code: 'quota_exceeded', message: source.error.message, param: null
});
assert.equal(streamErrorForProtocol('responses', { error: { message: 'connection reset' } }).code, '502');
assert.equal(streamErrorForProtocol('anthropic', source).error.type, 'rate_limit_error');
assert.equal(streamErrorForProtocol('openai', source).error.code, 'quota_exceeded');

for (const [status, type] of [
  [400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'],
  [403, 'permission_error'], [404, 'not_found_error'], [409, 'conflict_error'],
  [413, 'request_too_large'], [422, 'invalid_request_error'], [429, 'rate_limit_error'],
  [500, 'api_error'], [502, 'api_error'], [503, 'api_error'], [504, 'timeout_error'], [529, 'overloaded_error']
]) {
  assert.equal(errorForProtocol('anthropic', { message: 'failed' }, status).error.type, type);
  const original = { error: { type: 'vendor_error', code: 'vendor_code', param: 'model', message: 'failed' } };
  const normalized = errorForProtocol('anthropic', original, status);
  assert.equal(normalized.type, 'error');
  assert.deepEqual(normalized.error, { ...original.error, type, upstream_type: 'vendor_error' });
  assert.equal(original.error.type, 'vendor_error', '不能修改用于日志记录的原始错误');
  assert.deepEqual(errorForProtocol('openai', original, status), original, 'OpenAI 出口仍保留供应商错误类型');
}
assert.equal(streamErrorForProtocol('anthropic', { error: { type: 'server_error', message: 'failed' } }).error.type, 'api_error');
assert.equal(streamErrorForProtocol('anthropic', { error: { type: 'overloaded_error', message: 'busy' } }).error.type, 'overloaded_error');

assert.equal(appendRetrySummary(source, ''), source, '没有重试摘要时原样返回');
const summary = '已依次尝试：primary×2、fallback×1';
const nested = appendRetrySummary(source, summary);
assert.equal(nested.error.message, `配额不足\n请稍后重试（${summary}）`);
assert.equal(nested.error.code, 'quota_exceeded', 'code 必须保持原值');
assert.equal(nested.error.type, 'rate_limit_error', 'type 必须保持原值');
assert.equal(nested.error.param, null, 'param 必须保持原值');
assert.equal(nested.extra, 'preserved', '其余字段必须保留');
assert.equal(source.error.message, '配额不足\n请稍后重试', '不得修改原始对象');
const flat = appendRetrySummary(flatError, summary);
assert.equal(flat.message, `bad parameter（${summary}）`);
assert.equal(flat.code, 'invalid_request', '平铺错误的 code 必须保持原值');
assert.equal(flat.type, 'error');
assert.equal(flat.param, 'model');
assert.equal(flat.sequence_number, 1);
const textOnly = appendRetrySummary({ message: '无法连接上游' }, summary);
assert.equal(textOnly.message, `无法连接上游（${summary}）`);

console.log('error formatting tests passed');