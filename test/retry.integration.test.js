const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// 覆盖「同一上游原地重试 → 切换到下一优先级上游 → 返回错误」的完整链路：
// 每个上游按预设脚本依次响应，用来断言重试次数、切换时机和错误摘要。

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-retry-'));
const gatewayPort = 19100 + Math.floor(Math.random() * 500);

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

function waitForOutput(child, text) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时，输出：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        child.stdout?.removeListener('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error(`网关退出（${code}）：${output}`)); }
    });
  });
}

function jsonResponse(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

// 每个上游按脚本依次响应：脚本用尽后重复最后一步，方便构造「一直失败」的场景。
function createUpstream(name, plan) {
  const state = {
    name,
    hits: 0,
    plan: [...plan],
    server: http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      if (req.url === '/v1/models') {
        jsonResponse(res, 200, { object: 'list', data: [{ id: 'retry-model' }] });
        return;
      }
      if (req.url === '/v1/chat/completions') {
        const index = state.hits;
        state.hits += 1;
        const step = state.plan[Math.min(index, state.plan.length - 1)];
        if (step.disconnect) {
          req.socket.destroy();
          return;
        }
        const body = typeof step.errorMessage === 'string'
          ? { error: { message: step.errorMessage, type: step.errorType, code: step.errorCode } }
          : {
            id: `${name}-result-${index}`,
            model: 'retry-model',
            choices: [{ index: 0, message: { role: 'assistant', content: `served-by-${name}-${index}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          };
        jsonResponse(res, step.status ?? 200, body);
        return;
      }
      jsonResponse(res, 404, { error: { message: 'not found' } });
    })
  };
  return state;
}

async function main() {
  const primary = createUpstream('primary', [{ status: 200 }]);
  const secondary = createUpstream('secondary', [{ status: 200 }]);
  await new Promise((resolve) => primary.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => secondary.server.listen(0, '127.0.0.1', resolve));
  const primaryPort = primary.server.address().port;
  const secondaryPort = secondary.server.address().port;

  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const adminHeaders = {};
  try {
    await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));

    // 调高熔断阈值，避免连续失败把候选提前摘掉，干扰重试计数。
    const settingsUpdate = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({
        upstreamTimeoutMs: 15000,
        upstreamRetries: 0,
        maxFallbackAttempts: 0,
        retryDelayMs: 0,
        circuitBreakerFailureThreshold: 20,
        circuitBreakerCooldownMs: 600000
      })
    });
    assert.equal(settingsUpdate.status, 200, JSON.stringify(settingsUpdate.body));
    assert.equal(settingsUpdate.body.upstreamRetries, 0, '默认不应原地重试');

    const invalidRetries = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ upstreamRetries: 11 })
    });
    assert.equal(invalidRetries.status, 400, JSON.stringify(invalidRetries.body), 'upstreamRetries 超过上限必须被拒绝');

    const addUpstream = (name, port) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'retry-model' })
    });
    const primaryResult = await addUpstream('primary', primaryPort);
    const secondaryResult = await addUpstream('secondary', secondaryPort);
    assert.equal(primaryResult.status, 201, JSON.stringify(primaryResult.body));
    assert.equal(secondaryResult.status, 201, JSON.stringify(secondaryResult.body));

    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'retry-local', upstreamId: primaryResult.body.id, upstreamModel: 'retry-model', fallbackUpstreamIds: [secondaryResult.body.id] })
    });
    assert.equal(route.status, 201, JSON.stringify(route.body));

    const sendChat = (requestId, content = 'hello') => requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.localApiKeys[0].key}`, 'x-request-id': requestId },
      body: JSON.stringify({ model: 'retry-local', messages: [{ role: 'user', content }] })
    });
    const logFor = async (requestId) => {
      const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
      assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
      const entry = metrics.body.logs.find((item) => item.id === requestId);
      assert.ok(entry, `找不到请求 ${requestId} 的日志`);
      return entry;
    };
    const setRetries = (upstreamRetries) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ upstreamRetries })
    });
    const shape = (entry) => entry.attempts.map((item) => [item.upstream, item.status, item.retry]);
    const reset = (primaryPlan, secondaryPlan) => {
      primary.plan = primaryPlan;
      secondary.plan = secondaryPlan;
      primary.hits = 0;
      secondary.hits = 0;
    };

    // 1) 同一上游原地重试后成功：3 次尝试都在 primary，不算切换。
    reset([{ status: 503, errorMessage: 'primary unavailable' }, { status: 503, errorMessage: 'primary unavailable' }, { status: 200 }], [{ status: 200 }]);
    assert.equal((await setRetries(2)).status, 200);
    const retried = await sendChat('retry-same-upstream-1');
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.choices[0].message.content, 'served-by-primary-2');
    assert.equal(secondary.hits, 0, '重试成功不应切换到备用上游');
    const retriedLog = await logFor('retry-same-upstream-1');
    assert.equal(retriedLog.success, true);
    assert.equal(retriedLog.failover, false, '原地重试同一个站不算故障转移');
    assert.deepEqual(shape(retriedLog), [
      ['primary', 503, undefined],
      ['primary', 503, 1],
      ['primary', 200, 2]
    ]);
    assert.equal(retriedLog.error, undefined, '成功的请求不应记录错误信息');

    // 2) 重试次数用尽后切换到下一优先级上游。
    reset([{ status: 503, errorMessage: 'primary unavailable' }, { status: 503, errorMessage: 'primary unavailable' }], [{ status: 200 }]);
    assert.equal((await setRetries(1)).status, 200);
    const switched = await sendChat('retry-then-switch-2');
    assert.equal(switched.status, 200, JSON.stringify(switched.body));
    assert.equal(switched.body.choices[0].message.content, 'served-by-secondary-0');
    assert.equal(primary.hits, 2, 'primary 应原地重试一次后切走');
    const switchedLog = await logFor('retry-then-switch-2');
    assert.equal(switchedLog.failover, true, '换了上游应标记为故障转移');
    assert.deepEqual(shape(switchedLog), [
      ['primary', 503, undefined],
      ['primary', 503, 1],
      ['secondary', 200, undefined]
    ]);

    // 3) 所有上游都失败：错误信息要写明依次试过哪些站、各几次。
    reset([{ status: 503, errorMessage: 'primary unavailable' }], [{ status: 500, errorMessage: 'secondary exploded' }]);
    assert.equal((await setRetries(1)).status, 200);
    const exhausted = await sendChat('retry-exhausted-3');
    assert.equal(exhausted.status, 500, JSON.stringify(exhausted.body));
    assert.equal(exhausted.body.error.message.includes('secondary exploded'), true, '应透出最后一个上游的错误：' + exhausted.body.error.message);
    assert.equal(exhausted.body.error.message.includes('已依次尝试：primary×2、secondary×2'), true, '错误信息应包含重试摘要：' + exhausted.body.error.message);
    assert.equal(primary.hits, 2);
    assert.equal(secondary.hits, 2);
    const exhaustedLog = await logFor('retry-exhausted-3');
    assert.equal(exhaustedLog.success, false);
    assert.deepEqual(shape(exhaustedLog), [
      ['primary', 503, undefined],
      ['primary', 503, 1],
      ['secondary', 500, undefined],
      ['secondary', 500, 1]
    ]);
    assert.equal(exhaustedLog.error.includes('已依次尝试：primary×2、secondary×2'), true, '日志错误信息同样应包含重试摘要');
    assert.equal(exhaustedLog.attempts[0].error.message, 'primary unavailable', '首次失败也要记录错误详情');

    // 4) 不可重试的 4xx：既不原地重试，也不切换，直接返回上游错误。
    reset([{ status: 400, errorMessage: 'bad request from primary', errorType: 'invalid_request_error', errorCode: 'bad_request' }], [{ status: 200 }]);
    assert.equal((await setRetries(2)).status, 200);
    const clientError = await sendChat('retry-non-retryable-4');
    assert.equal(clientError.status, 400, JSON.stringify(clientError.body));
    assert.equal(clientError.body.error.message.includes('bad request from primary'), true);
    assert.equal(primary.hits, 1, '4xx 不应原地重试');
    assert.equal(secondary.hits, 0, '4xx 不应切换上游');
    const clientErrorLog = await logFor('retry-non-retryable-4');
    assert.deepEqual(shape(clientErrorLog), [['primary', 400, undefined]]);
    assert.equal(clientErrorLog.upstreamError.code, 'bad_request');

    // 5) 连接失败同样先原地重试，重试耗尽再切换，且错误详情落入日志。
    reset([{ status: 0, disconnect: true }], [{ status: 200 }]);
    assert.equal((await setRetries(1)).status, 200);
    const afterDisconnect = await sendChat('retry-disconnect-5');
    assert.equal(afterDisconnect.status, 200, JSON.stringify(afterDisconnect.body));
    assert.equal(afterDisconnect.body.choices[0].message.content, 'served-by-secondary-0');
    assert.equal(primary.hits, 2, '连接失败应原地重试一次');
    const disconnectLog = await logFor('retry-disconnect-5');
    assert.deepEqual(shape(disconnectLog), [
      ['primary', 502, undefined],
      ['primary', 502, 1],
      ['secondary', 200, undefined]
    ]);
    assert.equal(disconnectLog.attempts[0].error.status, 502);
    assert.ok(disconnectLog.attempts[0].error.message, '连接失败应记录错误详情');
  } finally {
    gateway.kill();
    primary.server.close();
    secondary.server.close();
  }
}

main().then(() => {
  console.log('upstream retry integration tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

