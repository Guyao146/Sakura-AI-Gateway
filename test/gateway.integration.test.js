const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-'));
const gatewayPort = 19000 + Math.floor(Math.random() * 1000);

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function waitForOutput(process, text) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时，输出：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        process.stdout?.removeListener('data', onData);
        resolve(output);
      }
    };
    process.stdout.on('data', onData);
    process.once('error', (error) => { clearTimeout(timer); reject(error); });
    process.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`网关退出（${code}）：${output}`)); }
    });
  });
}

function assertJsonError(result, requestId, code, message, prefix = '[TestGateway]') {
  assert.equal(result.headers['x-request-id'], requestId);
  assert.equal(result.body.request_id, requestId);
  assert.equal(result.body.error.message, `${prefix ? `${prefix} ` : ''}[request_id=${requestId}] [code=${code}] ${message}`);
}

async function main() {
  const observedRequestIds = [];
  const observedBalanceAuth = [];
  const observedFallbackBodies = [];
  let upstreamFailure = null;
  let slowStartedResolve;
  const slowStarted = new Promise((resolve) => { slowStartedResolve = resolve; });
  const primary = http.createServer(async (req, res) => {
    if (req.headers['x-request-id']) observedRequestIds.push({ upstream: 'primary', value: req.headers['x-request-id'] });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    if (req.url === '/api/usage/token') {
      observedBalanceAuth.push(req.headers.authorization || '');
      res.statusCode = req.headers.authorization === 'Bearer upstream-balance-secret' ? 200 : 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(res.statusCode === 200
        ? { code: true, data: { object: 'token_usage', total_granted: 1000000, total_used: 250000, total_available: 750000, unlimited_quota: false, expires_at: 1893456000 } }
        : { error: { message: 'invalid upstream key' } }));
      return;
    }
    if (req.url === '/v1/chat/completions' && ['rr-upstream', 'weighted-upstream'].includes(body.model)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'primary-success', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'served-by-primary' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Responses API is not supported' } }));
      return;
    }
    res.statusCode = req.url === '/v1/chat/completions' ? 503 : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/chat/completions'
      ? { error: { message: 'primary unavailable' } }
      : { object: 'list', data: [{ id: 'primary-synced-model' }] }));
  });
  const fallback = http.createServer(async (req, res) => {
    if (req.headers['x-request-id']) observedRequestIds.push({ upstream: 'fallback', value: req.headers['x-request-id'] });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/usage/token' || req.url === '/api/v1/user/platform-quotas') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { message: `invalid credential: ${req.headers.authorization || ''}` } }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      observedFallbackBodies.push(body);
      if (upstreamFailure) {
        if (upstreamFailure.disconnect) return req.socket.destroy();
        res.statusCode = upstreamFailure.status;
        res.setHeader('x-request-id', 'upstream-only-request');
        res.end(upstreamFailure.raw ?? JSON.stringify(upstreamFailure.body));
        return;
      }
      if (raw.includes('slow-concurrency-test')) {
        slowStartedResolve();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      res.end(JSON.stringify({ id: 'fallback-result', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'served-by-fallback' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
      return;
    }
    if (req.url === '/v1/responses') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'Responses API is not supported' } }));
      return;
    }
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise((resolve) => primary.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => fallback.listen(0, '127.0.0.1', resolve));
  const primaryPort = primary.address().port;
  const fallbackPort = fallback.address().port;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const visibleConfig = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(visibleConfig.status, 200, JSON.stringify(visibleConfig.body));
    assert.equal(visibleConfig.body.localApiKeys[0].key, config.localApiKeys[0].key, '管理后台应返回完整本地调用 Key');
    const add = (name, port, authType = 'none', apiKey = '') => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', responsesMode: 'chat', authType, apiKey, models: 'test-model' })
    });
    const invalidBalanceEndpoint = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'invalid-balance-endpoint', baseUrl: `http://127.0.0.1:${primaryPort}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'test-model', balanceEndpoint: 'https://evil.example/balance' })
    });
    assert.equal(invalidBalanceEndpoint.status, 400, JSON.stringify(invalidBalanceEndpoint.body));
    const primaryResult = await add('primary', primaryPort, 'bearer', 'upstream-balance-secret');
    const fallbackResult = await add('fallback', fallbackPort, 'bearer', 'fallback-balance-secret');
    const initialSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, { headers: adminHeaders });
    assert.equal(initialSettings.status, 200, JSON.stringify(initialSettings.body));
    assert.equal(initialSettings.body.maxFallbackAttempts, 0);
    const updatedSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ upstreamTimeoutMs: 120000, maxFallbackAttempts: 1, retryDelayMs: 0, circuitBreakerFailureThreshold: 1, circuitBreakerCooldownMs: 60000, errorPrefix: '[TestGateway]' })
    });
    assert.equal(updatedSettings.status, 200, JSON.stringify(updatedSettings.body));
    assert.equal(updatedSettings.body.upstreamTimeoutMs, 120000);
    assert.equal(updatedSettings.body.maxFallbackAttempts, 1);
    assert.equal(updatedSettings.body.circuitBreakerFailureThreshold, 1);
    assert.equal(updatedSettings.body.errorPrefix, '[TestGateway]');
    // 自定义错误前缀的实际生效验证放在所有 metrics 计数断言之后，避免额外的
    // 404 请求污染 totals/byUpstream 计数。
    assert.equal(primaryResult.status, 201, output);
    assert.equal(fallbackResult.status, 201, output);
    assert.equal(primaryResult.body.apiKey.includes('upstream-balance-secret'), false, '管理接口不得返回完整上游 Key');
    const initialBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances`, { headers: adminHeaders });
    assert.equal(initialBalances.status, 200, JSON.stringify(initialBalances.body));
    assert.equal(initialBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).state, 'idle');
    const primaryBalance = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/balance`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(primaryBalance.status, 200, JSON.stringify(primaryBalance.body));
    assert.equal(primaryBalance.body.state, 'ok');
    assert.equal(primaryBalance.body.endpoint, '/api/usage/token');
    assert.equal(primaryBalance.body.balance.type, 'quota');
    assert.equal(primaryBalance.body.balance.remaining, 750000);
    assert.equal(primaryBalance.body.balance.used, 250000);
    assert.equal(JSON.stringify(primaryBalance.body).includes('upstream-balance-secret'), false);
    assert.deepEqual(observedBalanceAuth, ['Bearer upstream-balance-secret']);
    const cachedBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances`, { headers: adminHeaders });
    assert.equal(cachedBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).balance.granted, 1000000);
    const allBalances = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-balances/query`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(allBalances.status, 200, JSON.stringify(allBalances.body));
    assert.equal(allBalances.body.items.find((item) => item.upstreamId === primaryResult.body.id).state, 'ok');
    const failedBalance = allBalances.body.items.find((item) => item.upstreamId === fallbackResult.body.id);
    assert.equal(failedBalance.state, 'error');
    assert.match(failedBalance.message, /\[已隐藏\]/);
    assert.equal(JSON.stringify(failedBalance).includes('fallback-balance-secret'), false);
    const sync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/sync-models`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.count, 2);
    assert.deepEqual(sync.body.models, ['primary-synced-model', 'test-model']);
    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ localModel: 'test-local', upstreamId: primaryResult.body.id, upstreamModel: 'test-model', fallbackUpstreamIds: [fallbackResult.body.id] })
    });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    const response = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.choices[0].message.content, 'served-by-fallback');
    assert.equal(response.headers['x-request-id'], 'client-request-001');
    assert.deepEqual(observedRequestIds.slice(0, 2), [
      { upstream: 'primary', value: 'client-request-001' },
      { upstream: 'fallback', value: 'client-request-001' }
    ]);
    const healthAfterFirst = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-status`, { headers: adminHeaders });
    assert.equal(healthAfterFirst.status, 200, JSON.stringify(healthAfterFirst.body));
    const primaryHealthAfterFirst = healthAfterFirst.body.items.find((item) => item.name === 'primary');
    assert.equal(primaryHealthAfterFirst.state, 'open');
    assert.equal(primaryHealthAfterFirst.consecutiveFailures, 1);
    assert.equal(JSON.stringify(primaryHealthAfterFirst).includes('18890'), false);
    assert.equal(JSON.stringify(primaryHealthAfterFirst).includes('test-key'), false);
    const directFallbackResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-002' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'hello again' }] })
    });
    assert.equal(directFallbackResponse.status, 200, JSON.stringify(directFallbackResponse.body));
    assert.equal(directFallbackResponse.body.choices[0].message.content, 'served-by-fallback');
    assert.deepEqual(observedRequestIds.slice(2, 3), [{ upstream: 'fallback', value: 'client-request-002' }]);
    const resetHealth = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(resetHealth.status, 200, JSON.stringify(resetHealth.body));
    assert.equal(resetHealth.body.state, 'closed');
    const afterResetResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'client-request-003' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'after reset' }] })
    });
    assert.equal(afterResetResponse.status, 200, JSON.stringify(afterResetResponse.body));
    assert.equal(afterResetResponse.body.choices[0].message.content, 'served-by-fallback');
    assert.deepEqual(observedRequestIds.slice(3, 5), [
      { upstream: 'primary', value: 'client-request-003' },
      { upstream: 'fallback', value: 'client-request-003' }
    ]);
    const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
    assert.equal(metrics.body.totals.requests, 3);
    assert.equal(metrics.body.totals.successful, 3);
    assert.equal(metrics.body.totals.failed, 0);
    assert.equal(metrics.body.totals.failovers, 2);
    assert.equal(metrics.body.totals.promptTokens, 33);
    assert.equal(metrics.body.totals.completionTokens, 21);
    assert.equal(metrics.body.totals.totalTokens, 54);
    assert.equal(metrics.body.logs[0].failover, true);
    assert.equal(metrics.body.logs.find((entry) => entry.id && entry.attempts.length === 1).attempts[0].upstream, 'fallback');
    assert.equal(metrics.body.logs.find((entry) => entry.id && entry.attempts.length === 1).attempts[0].status, 200);
    assert.equal(metrics.body.byUpstream.primary.failed, 2);
    assert.equal(metrics.body.byUpstream.fallback.successful, 3);
    assert.equal(metrics.body.byUpstream.fallback.totalTokens, 54);
    const usageExport = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/export?scope=all`, { headers: adminHeaders });
    assert.equal(usageExport.status, 200, JSON.stringify(usageExport.body));
    assert.equal(usageExport.body.scope, 'all');
    assert.equal(usageExport.body.records.length, 3);
    assert.equal(usageExport.body.records[0].id, 'client-request-001');
    assert.equal(directFallbackResponse.body.request_id, 'client-request-002');
    const recentUsageExport = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/export?scope=recent`, { headers: adminHeaders });
    assert.equal(recentUsageExport.status, 200, JSON.stringify(recentUsageExport.body));
    assert.equal(recentUsageExport.body.scope, 'recent');
    assert.equal(recentUsageExport.body.records.length, 3);
    // —— 错误格式回归：放在计数断言之后，不影响原有的成功/故障转移计数。——
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const endpoints = [
      ['chat', '/v1/chat/completions', { messages: [{ role: 'user', content: 'error regression' }] }],
      ['responses', '/v1/responses', { input: 'error regression' }],
      ['anthropic', '/v1/messages', { messages: [{ role: 'user', content: 'error regression' }], max_tokens: 32 }]
    ];
    for (const [protocol, endpoint, input] of endpoints) {
      const call = (requestId, body, headers = localHeaders) => requestJson(`http://127.0.0.1:${gatewayPort}${endpoint}`, {
        method: 'POST', headers: { ...headers, 'x-request-id': requestId }, body
      });
      const missingModelId = `missing-model-${protocol}`;
      const missingModel = await call(missingModelId, JSON.stringify(input));
      assert.equal(missingModel.status, 400);
      assertJsonError(missingModel, missingModelId, '400', 'model 不能为空');
      if (protocol === 'anthropic') assert.equal(missingModel.body.type, 'error');
      const unauthorizedId = `unauthorized-${protocol}`;
      const unauthorized = await call(unauthorizedId, JSON.stringify(input), {});
      assert.equal(unauthorized.status, 401);
      assert.equal(unauthorized.body.error.type, 'authentication_error');
      assertJsonError(unauthorized, unauthorizedId, '401', '需要有效的本地 API Key');
      if (protocol === 'anthropic') assert.equal(unauthorized.body.type, 'error');
      const malformedId = `malformed-${protocol}`;
      const malformed = await call(malformedId, '{');
      assert.equal(malformed.status, 400);
      assertJsonError(malformed, malformedId, '400', '请求体必须是有效 JSON');
      // 两个上游均可用时未知模型才返回 404；仅一个可用上游会自动接收任意模型。
      await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/reset-health`, {
        method: 'POST', headers: adminHeaders, body: '{}'
      });
      const unknownModelId = `unknown-model-${protocol}`;
      const unknownModel = await call(unknownModelId, JSON.stringify({ ...input, model: 'not-configured-error-regression' }));
      assert.equal(unknownModel.status, 404, JSON.stringify(unknownModel.body));
      assertJsonError(unknownModel, unknownModelId, '404', '没有找到模型 not-configured-error-regression 的可用上游，请先在后台配置路由');

      upstreamFailure = {
        status: 400,
        body: { request_id: 'upstream-only-request', error: { message: '上游配额不足\n请稍后重试', code: 'quota_exceeded', type: 'quota_error', param: 'model' }, extra: 'preserved' }
      };
      for (const stream of [false, true]) {
        const requestId = `upstream-json-${protocol}-${stream}`;
        const failure = await call(requestId, JSON.stringify({ ...input, model: 'test-local', stream }));
        assert.equal(failure.status, 400);
        assertJsonError(failure, requestId, 'quota_exceeded', '上游配额不足\n请稍后重试');
        assert.equal(failure.body.error.code, 'quota_exceeded');
        assert.equal(failure.body.error.type, protocol === 'anthropic' ? 'invalid_request_error' : 'quota_error');
        if (protocol === 'anthropic') assert.equal(failure.body.error.upstream_type, 'quota_error');
        assert.equal(failure.body.error.param, 'model');
        assert.equal(failure.body.extra, 'preserved');
        assert.ok(observedRequestIds.some((entry) => entry.value === requestId), '请求 ID 应透传给上游');
      }
      upstreamFailure = null;
    }
    const codeCases = [
      { status: 400, body: { error: { code: 0, message: 'numeric zero' } }, code: '0', message: 'numeric zero' },
      { status: 401, body: { error: { code: null, type: 'authentication_error', message: 'missing code' } }, code: '401', message: 'missing code' },
      { status: 418, raw: 'plain text 错误', code: '418', message: 'plain text 错误' },
      { status: 400, body: { error: 'string error' }, code: '400', message: 'string error' },
      { status: 400, body: { code: 'root_code', message: 'root error', param: 'model' }, code: 'root_code', message: 'root error' },
      { status: 400, body: { error: { message: '[TestGateway] already prefixed' } }, code: '400', message: 'already prefixed' },
      { status: 200, body: { error: { code: 'soft_failure', message: 'error inside HTTP 200' } }, code: 'soft_failure', message: 'error inside HTTP 200' }
    ];
    for (const [index, failure] of codeCases.entries()) {
      upstreamFailure = failure;
      const requestId = `error-code-${index}`;
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
        body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'error code' }] })
      });
      assert.equal(result.status, failure.status === 200 ? 502 : failure.status, 'HTTP 200 错误体应返回 502');
      assertJsonError(result, requestId, failure.code, failure.message);
      if (failure.body?.error && typeof failure.body.error === 'object') {
        assert.equal(result.body.error.code, failure.body.error.code, '结构化 code 保持原值');
      }
    }
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(fallbackResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    upstreamFailure = { disconnect: true };
    const disconnected = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'connection-error' },
      body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'disconnect' }] })
    });
    upstreamFailure = null;
    assert.equal(disconnected.status, 502);
    assert.equal(disconnected.body.request_id, 'connection-error');
    assert.match(disconnected.body.error.message, /^\[TestGateway\] \[request_id=connection-error\] \[code=502\] 无法连接上游：/);
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(fallbackResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    for (const [endpoint, message] of [['/v1/not-found', '接口不存在'], ['/api/admin/not-found', '管理接口不存在']]) {
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}${endpoint}`, { headers: { 'x-request-id': 'unknown-endpoint' } });
      assert.equal(result.status, 404);
      assertJsonError(result, 'unknown-endpoint', '404', message);
    }
    // 清空只省略自定义前缀；自动生成的请求 ID 和错误码仍然展示。
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ errorPrefix: '' })
    });
    const plainError = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(plainError.status, 400);
    assert.match(plainError.headers['x-request-id'], /^req_[0-9a-f]{16}$/);
    assertJsonError(plainError, plainError.headers['x-request-id'], '400', 'model 不能为空', '');
    const invalidRequestId = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': '[invalid request id]' }, body: '{}'
    });
    assert.match(invalidRequestId.headers['x-request-id'], /^req_[0-9a-f]{16}$/);
    assertJsonError(invalidRequestId, invalidRequestId.headers['x-request-id'], '400', 'model 不能为空', '');
    const errorLogs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=100`, { headers: adminHeaders });
    const plainErrorLog = errorLogs.body.items.find((entry) => entry.id === plainError.body.request_id);
    assert.ok(plainErrorLog, '消息里的请求 ID 应可用于查询请求日志');
    assert.equal(plainErrorLog.error, 'model 不能为空', '客户端装饰不能改写日志中的原始错误');
    assert.equal(plainErrorLog.upstreamError, undefined, '网关本地错误不应伪造上游错误信息');
    const rejectedLog = errorLogs.body.items.find((entry) => entry.id === 'error-code-0');
    assert.ok(rejectedLog, '上游返回的错误应记入请求日志');
    assert.deepEqual(rejectedLog.upstreamError, { status: 400, code: '0', message: 'numeric zero' }, '日志记录上游返回的结构化错误');
    assert.ok(rejectedLog.attempts.some((attempt) => attempt.error?.code === '0'), '每次上游尝试都应带上游错误码');
    const softFailureLog = errorLogs.body.items.find((entry) => entry.id === 'error-code-6');
    assert.deepEqual(softFailureLog.upstreamError, { status: 200, code: 'soft_failure', message: 'error inside HTTP 200' }, 'HTTP 200 内的失败也要记录上游错误');
    const responsesResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', instructions: 'Be concise', input: 'hello responses', max_output_tokens: 40 })
    });
    assert.equal(responsesResponse.status, 200, JSON.stringify(responsesResponse.body));
    assert.equal(responsesResponse.body.object, 'response');
    assert.equal(responsesResponse.body.output_text, 'served-by-fallback');
    assert.equal(responsesResponse.body.usage.total_tokens, 18);
    const exported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/export`, { headers: adminHeaders });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.exportVersion, 1);
    assert.equal(exported.body.config.adminToken, config.adminToken);
    assert.equal(exported.body.config.localApiKeys[0].key, config.localApiKeys[0].key);
    assert.equal(exported.body.config.upstreams.length, 2);
    const importedBackup = JSON.parse(JSON.stringify(exported.body));
    importedBackup.config.adminToken = 'admin_imported_should_not_replace_current';
    importedBackup.config.localApiKeys[0].key = 'sk-local_imported_should_not_replace_current';
    const imported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/import`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...importedBackup, preserveCredentials: true })
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const afterImport = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(afterImport.status, 200, JSON.stringify(afterImport.body));
    assert.equal(afterImport.body.routes.length, 1);
    const importedResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', input: 'after import' })
    });
    assert.equal(importedResponse.status, 200, JSON.stringify(importedResponse.body));
    assert.equal(importedResponse.body.output_text, 'served-by-fallback');
    const resetForStrategies = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(primaryResult.body.id)}/reset-health`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(resetForStrategies.status, 200, JSON.stringify(resetForStrategies.body));
    const roundRobinRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'round-robin-local', upstreamId: primaryResult.body.id, upstreamModel: 'rr-upstream', fallbackUpstreamIds: [fallbackResult.body.id], strategy: 'round_robin' })
    });
    assert.equal(roundRobinRoute.status, 201, JSON.stringify(roundRobinRoute.body));
    const beforeRoundRobin = observedRequestIds.length;
    for (const requestId of ['rr-request-001', 'rr-request-002']) {
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': requestId }, body: JSON.stringify({ model: 'round-robin-local', messages: [{ role: 'user', content: requestId }] })
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    assert.deepEqual(observedRequestIds.slice(beforeRoundRobin, beforeRoundRobin + 2), [
      { upstream: 'primary', value: 'rr-request-001' },
      { upstream: 'fallback', value: 'rr-request-002' }
    ]);
    const weightedRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'weighted-local', upstreamId: primaryResult.body.id, upstreamModel: 'weighted-upstream', fallbackUpstreamIds: [fallbackResult.body.id], strategy: 'weighted', upstreamWeights: { [primaryResult.body.id]: 2, [fallbackResult.body.id]: 1 } })
    });
    assert.equal(weightedRoute.status, 201, JSON.stringify(weightedRoute.body));
    const beforeWeighted = observedRequestIds.length;
    for (const requestId of ['weighted-request-001', 'weighted-request-002', 'weighted-request-003']) {
      const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': requestId }, body: JSON.stringify({ model: 'weighted-local', messages: [{ role: 'user', content: requestId }] })
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    assert.deepEqual(observedRequestIds.slice(beforeWeighted, beforeWeighted + 3), [
      { upstream: 'primary', value: 'weighted-request-001' },
      { upstream: 'fallback', value: 'weighted-request-002' },
      { upstream: 'primary', value: 'weighted-request-003' }
    ]);
    const stripRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'thinking-off-local', upstreamId: fallbackResult.body.id, upstreamModel: 'test-model', fallbackUpstreamIds: [], strategy: 'failover', thinkingLevel: 'off' })
    });
    assert.equal(stripRoute.status, 201, JSON.stringify(stripRoute.body));
    const noThinkingUpstream = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'no-thinking', baseUrl: `http://127.0.0.1:${fallbackPort}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'no-thinking-model', modelCatalog: [{ id: 'no-thinking-model', supportsThinking: false }] })
    });
    assert.equal(noThinkingUpstream.status, 201, JSON.stringify(noThinkingUpstream.body));
    const noThinkingRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'no-thinking-local', upstreamId: noThinkingUpstream.body.id, upstreamModel: 'no-thinking-model', fallbackUpstreamIds: [], strategy: 'failover', thinkingLevel: 'auto' })
    });
    assert.equal(noThinkingRoute.status, 201, JSON.stringify(noThinkingRoute.body));
    const beforeStrip = observedFallbackBodies.length;
    const stripResult = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'thinking-off-local', messages: [{ role: 'user', content: 'strip-reasoning-off' }], reasoning_effort: 'high' })
    });
    assert.equal(stripResult.status, 200, JSON.stringify(stripResult.body));
    const noThinkingResult = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'no-thinking-local', messages: [{ role: 'user', content: 'strip-reasoning-capability' }], reasoning_effort: 'high' })
    });
    assert.equal(noThinkingResult.status, 200, JSON.stringify(noThinkingResult.body));
    const strippedBodies = observedFallbackBodies.slice(beforeStrip);
    assert.equal(strippedBodies.length, 2, JSON.stringify(strippedBodies));
    for (const strippedBody of strippedBodies) {
      assert.equal(strippedBody.reasoning_effort, undefined, '不支持思考的模型应剥离客户端显式传入的 reasoning_effort');
    }
    const strategyMetrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(strategyMetrics.status, 200, JSON.stringify(strategyMetrics.body));
    assert.equal(strategyMetrics.body.logs.find((entry) => entry.model === 'round-robin-local').strategy, 'round_robin');
    assert.equal(strategyMetrics.body.logs.find((entry) => entry.model === 'weighted-local').strategy, 'weighted');
    const concurrentSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 1, requestsPerMinute: 0 })
    });
    assert.equal(concurrentSettings.status, 200, JSON.stringify(concurrentSettings.body));
    assert.equal(concurrentSettings.body.maxConcurrentRequests, 1);
    const slowRequest = requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'concurrency-slow-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'slow-concurrency-test' }] })
    });
    await Promise.race([
      slowStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('慢请求没有到达 mock 上游')), 3000))
    ]);
    const observedBeforeConcurrentDenied = observedRequestIds.length;
    const concurrentDenied = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'concurrency-denied-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'should-be-rejected' }] })
    });
    assert.equal(concurrentDenied.status, 429, JSON.stringify(concurrentDenied.body));
    assert.equal(concurrentDenied.headers['x-request-id'], 'concurrency-denied-001');
    assertJsonError(concurrentDenied, 'concurrency-denied-001', '429', '当前模型请求并发数已达到上限', '');
    assert.equal(concurrentDenied.headers['retry-after'], '1');
    assert.equal(observedRequestIds.length, observedBeforeConcurrentDenied);
    const slowResult = await slowRequest;
    assert.equal(slowResult.status, 200, JSON.stringify(slowResult.body));
    const releasedRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'slot-released' }] })
    });
    assert.equal(releasedRequest.status, 200, JSON.stringify(releasedRequest.body));
    const rateSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 0, requestsPerMinute: 1 })
    });
    assert.equal(rateSettings.status, 200, JSON.stringify(rateSettings.body));
    const rateAllowed = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'rate-allowed' }] })
    });
    assert.equal(rateAllowed.status, 200, JSON.stringify(rateAllowed.body));
    const observedBeforeRateDenied = observedRequestIds.length;
    const rateDenied = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': 'rate-denied-001' }, body: JSON.stringify({ model: 'test-local', messages: [{ role: 'user', content: 'should-be-rate-limited' }] })
    });
    assert.equal(rateDenied.status, 429, JSON.stringify(rateDenied.body));
    assert.equal(rateDenied.headers['x-request-id'], 'rate-denied-001');
    assertJsonError(rateDenied, 'rate-denied-001', '429', '该本地 API Key 已达到每分钟请求上限', '');
    assert.ok(Number(rateDenied.headers['retry-after']) >= 1);
    assert.equal(observedRequestIds.length, observedBeforeRateDenied);
    const unlimitedSettings = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ maxConcurrentRequests: 0, requestsPerMinute: 0 })
    });
    assert.equal(unlimitedSettings.status, 200, JSON.stringify(unlimitedSettings.body));
    const createdKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'visible-after-create' })
    });
    assert.equal(createdKey.status, 201, JSON.stringify(createdKey.body));
    assert.match(createdKey.body.item.key, /^sk-local_/);
    const configAfterKeyCreate = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(configAfterKeyCreate.status, 200, JSON.stringify(configAfterKeyCreate.body));
    assert.equal(
      configAfterKeyCreate.body.localApiKeys.find((item) => item.id === createdKey.body.item.id)?.key,
      createdKey.body.item.key,
      '新建后重新读取配置仍应返回完整本地 Key'
    );
    const deleteCreatedKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(createdKey.body.item.id)}`, {
      method: 'DELETE', headers: adminHeaders
    });
    assert.equal(deleteCreatedKey.status, 200, JSON.stringify(deleteCreatedKey.body));
    const keyId = config.localApiKeys[0].id;
    const disabledKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: 'disabled-key', enabled: false })
    });
    assert.equal(disabledKey.status, 200, JSON.stringify(disabledKey.body));
    assert.equal(disabledKey.body.key, config.localApiKeys[0].key, '更新本地 Key 后仍应返回完整值');
    const disabledRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/models`, {
      headers: { Authorization: `Bearer ${config.localApiKeys[0].key}` }
    });
    assert.equal(disabledRequest.status, 401);
    assertJsonError(disabledRequest, disabledRequest.headers['x-request-id'], '401', '需要有效的本地 API Key', '');
    const enabledKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: 're-enabled-key', enabled: true })
    });
    assert.equal(enabledKey.status, 200, JSON.stringify(enabledKey.body));
    const lastKeyDelete = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'DELETE', headers: adminHeaders
    });
    assert.equal(lastKeyDelete.status, 400, JSON.stringify(lastKeyDelete.body));
    console.log('gateway integration tests passed');
  } catch (error) {
    throw new Error(`${error.stack}\n${stderr}`);
  } finally {
    gateway.kill();
    await Promise.all([
      new Promise((resolve) => primary.close(resolve)),
      new Promise((resolve) => fallback.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});