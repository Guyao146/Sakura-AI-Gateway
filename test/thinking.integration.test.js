const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// 「拉取思考强度」全链路覆盖：
// 元数据已声明 → 跳过探测；OpenAI 协议逐档试探 → 只保留上游接受的档位；
// 参数被整体拒绝 → 提前结束；429 → 不改写原有判断；
// 探测结果要能挺过后续的模型同步，且不写入请求指标、不占用熔断状态。

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-thinking-'));
const gatewayPort = 25000 + Math.floor(Math.random() * 400);

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

function chatOk(model) {
  return {
    id: 'probe-result',
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  };
}


// OpenAI 兼容站点：meta-model 由 /v1/models 直接声明档位；probe-model 只接受低/中；
// none-model 整体拒绝 reasoning_effort；flaky-model 一律 429，且错误文案里带 reasoning。
function createOpenAIUpstream() {
  const state = { chat: [], server: null, timeoutMode: null, timeoutResponses: new Set() };
  state.server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, { object: 'list', data: [
        { id: 'meta-model', supports_thinking: true, thinking_levels: ['low', 'medium'] },
        { id: 'probe-model' },
        { id: 'none-model' },
        { id: 'flaky-model' }
      ] });
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const effort = body.reasoning_effort;
      state.chat.push({ model: body.model, effort, maxTokens: body.max_tokens });
      // 失败行为只对探测请求生效（探测固定用 max_tokens: 1），真实请求照常成功，
      // 这样既能试探能力，又能验证网关拿到结论后的转发行为。
      const probing = body.max_tokens === 1;
      if (body.model === 'timeout-model' && probing && state.timeoutMode) {
        if (state.timeoutMode === 'body') { res.writeHead(429, { 'content-type': 'application/json' }); res.flushHeaders(); }
        state.timeoutResponses.add(res);
        res.once('close', () => state.timeoutResponses.delete(res));
        return;
      }
      if (body.model === 'probe-model' && effort === 'high' && probing) {
        jsonResponse(res, 400, { error: { message: 'reasoning_effort must be one of: low, medium', type: 'invalid_request_error' } });
        return;
      }
      if (body.model === 'none-model' && probing) {
        jsonResponse(res, 400, { error: { message: 'Unsupported parameter: reasoning_effort', type: 'invalid_request_error' } });
        return;
      }
      if (body.model === 'flaky-model' && probing) {
        jsonResponse(res, 429, { error: { message: 'Rate limit reached on reasoning requests', type: 'rate_limit_error' } });
        return;
      }
      jsonResponse(res, 200, chatOk(body.model));
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  return state;
}

// Anthropic 站点：思考强度体现为 budget_tokens，一次最小预算请求即可确认能力。
function createAnthropicUpstream() {
  const state = { messages: [], server: null };
  state.server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, { object: 'list', data: [{ id: 'claude-model' }, { id: 'claude-nope' }] });
      return;
    }
    if (req.url === '/v1/messages') {
      state.messages.push({ model: body.model, maxTokens: body.max_tokens, thinking: body.thinking });
      if (body.model === 'claude-nope') {
        jsonResponse(res, 400, { error: { message: 'thinking is not supported for this model', type: 'invalid_request_error' } });
        return;
      }
      jsonResponse(res, 200, {
        id: 'msg_probe',
        model: body.model,
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  return state;
}

async function catalogModels(catalog, upstreamId) {
  const upstream = catalog.body.upstreams.find((item) => item.id === upstreamId);
  return new Map(upstream.models.map((model) => [model.id, model]));
}


async function main() {
  const openai = createOpenAIUpstream();
  const anthropic = createAnthropicUpstream();
  await new Promise((resolve) => openai.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => anthropic.server.listen(0, '127.0.0.1', resolve));
  const openaiPort = openai.server.address().port;
  const anthropicPort = anthropic.server.address().port;

  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForOutput(gateway, '本地管理访问：无需认证');
    const settingsUpdate = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', body: JSON.stringify({ upstreamTimeoutMs: 15000, upstreamRetries: 0, maxFallbackAttempts: 0, retryDelayMs: 0 })
    });
    assert.equal(settingsUpdate.status, 200, JSON.stringify(settingsUpdate.body));

    const addUpstream = (name, port, protocol) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol, authType: 'none', apiKey: '', models: '' })
    });
    const openaiUpstream = await addUpstream('probe-openai', openaiPort, 'openai');
    const anthropicUpstream = await addUpstream('probe-anthropic', anthropicPort, 'anthropic');
    assert.equal(openaiUpstream.status, 201, JSON.stringify(openaiUpstream.body));
    assert.equal(anthropicUpstream.status, 201, JSON.stringify(anthropicUpstream.body));

    const syncOpenai = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${openaiUpstream.body.id}/sync-models`, { method: 'POST', body: '{}' });
    const syncAnthropic = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${anthropicUpstream.body.id}/sync-models`, { method: 'POST', body: '{}' });
    assert.equal(syncOpenai.status, 200, JSON.stringify(syncOpenai.body));
    assert.equal(syncAnthropic.status, 200, JSON.stringify(syncAnthropic.body));
    assert.equal(openai.chat.length, 0, '同步模型不应产生任何对话请求');

    // 1) 探测前：只有 /v1/models 声明过能力的模型有档位，其余能力未知。
    const before = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`);
    const beforeModels = await catalogModels(before, openaiUpstream.body.id);
    assert.deepEqual(beforeModels.get('meta-model').thinkingLevels, ['low', 'medium']);
    assert.equal(beforeModels.get('meta-model').thinkingSource, 'metadata');
    assert.equal(beforeModels.get('probe-model').thinkingSource, 'unknown');
    assert.equal(beforeModels.get('probe-model').supportsThinking, null, '上游没表态时不能臆测');
    assert.equal(beforeModels.get('none-model').supportsThinking, null);
    assert.equal(beforeModels.get('none-model').thinkingProbedAt, null, '未探测时不应有探测时间');

    // 2) 全部探测：元数据声明过的跳过，其余逐档试探。
    const probed = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/thinking-probe`, { method: 'POST', body: '{}' });
    assert.equal(probed.status, 200, JSON.stringify(probed.body));
    const openaiResult = probed.body.results.find((item) => item.upstreamId === openaiUpstream.body.id);
    const anthropicResult = probed.body.results.find((item) => item.upstreamId === anthropicUpstream.body.id);
    assert.equal(openaiResult.status, 'ok', JSON.stringify(probed.body));
    assert.deepEqual(
      { total: openaiResult.total, probed: openaiResult.probed, supported: openaiResult.supported, unsupported: openaiResult.unsupported, skipped: openaiResult.skipped, failed: openaiResult.failed },
      { total: 4, probed: 2, supported: 1, unsupported: 1, skipped: 1, failed: 1 },
      JSON.stringify(openaiResult)
    );
    assert.deepEqual(
      { probed: anthropicResult.probed, supported: anthropicResult.supported, unsupported: anthropicResult.unsupported },
      { probed: 2, supported: 1, unsupported: 1 },
      JSON.stringify(anthropicResult)
    );

    // 探测代价：probe-model 三档各一次；none-model 首次即被整体拒绝，不浪费时间；
    // meta-model 完全不发请求；flaky-model 遇到 429 后不再继续试其它档位。
    const chatModels = openai.chat.map((item) => item.model);
    assert.equal(chatModels.filter((model) => model === 'probe-model').length, 3, JSON.stringify(openai.chat));
    assert.equal(chatModels.filter((model) => model === 'none-model').length, 1, '参数被整体拒绝时应提前结束');
    assert.equal(chatModels.filter((model) => model === 'flaky-model').length, 1, '429 与能力无关，不应逐档重试');
    assert.equal(chatModels.includes('meta-model'), false, '元数据已声明的模型不应再探测');
    const probeEfforts = openai.chat.filter((item) => item.model === 'probe-model').map((item) => item.effort);
    assert.deepEqual(probeEfforts, ['low', 'medium', 'high'], JSON.stringify(probeEfforts));
    assert.equal(openai.chat.every((item) => item.maxTokens === 1), true, 'OpenAI 协议探测必须用 max_tokens=1 控制成本');
    assert.equal(anthropic.messages.filter((item) => item.model === 'claude-model').length, 1, 'Anthropic 一次最小预算即可确认能力');
    const claudeProbe = anthropic.messages.find((item) => item.model === 'claude-model');
    assert.equal(claudeProbe.maxTokens, 1025, 'max_tokens 必须大于 budget_tokens');
    assert.deepEqual(claudeProbe.thinking, { type: 'enabled', budget_tokens: 1024 }, '应取协议允许的最小思考预算');


    // 3) 探测结论落库，并按模型分别呈现。
    const after = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`);
    const models = await catalogModels(after, openaiUpstream.body.id);
    assert.deepEqual(models.get('probe-model').thinkingLevels, ['low', 'medium']);
    assert.equal(models.get('probe-model').supportsThinking, true);
    assert.equal(models.get('probe-model').thinkingSource, 'probe');
    assert.ok(models.get('probe-model').thinkingProbedAt, '探测成功的模型应记录探测时间');
    assert.equal(models.get('none-model').supportsThinking, false, '整体拒绝 reasoning_effort 即不支持思考');
    assert.deepEqual(models.get('none-model').thinkingLevels, []);
    assert.equal(models.get('none-model').thinkingSource, 'probe');
    assert.equal(models.get('flaky-model').supportsThinking, null, '429 不能改写原有判断');
    assert.equal(models.get('flaky-model').thinkingSource, 'unknown', '失败的探测不应留下结论');
    assert.equal(models.get('flaky-model').thinkingProbedAt, null);
    assert.equal(models.get('meta-model').thinkingSource, 'metadata', '元数据来源不应被探测覆盖');
    const anthropicModels = await catalogModels(after, anthropicUpstream.body.id);
    assert.equal(anthropicModels.get('claude-model').supportsThinking, true);
    assert.deepEqual(anthropicModels.get('claude-model').thinkingLevels, ['low', 'medium', 'high']);
    assert.equal(anthropicModels.get('claude-nope').supportsThinking, false);

    // 4) 探测不应写入请求指标，也不应触发熔断。
    const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.totals.requests, 0, '探测请求不应计入请求统计');
    assert.equal(metrics.body.logs.length, 0, '探测请求不应写入日志');
    const health = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstream-status`);
    const openaiHealth = health.body.items.find((item) => item.upstreamId === openaiUpstream.body.id);
    assert.equal(openaiHealth.state, 'closed', '探测失败不应打开熔断');
    assert.equal(openaiHealth.consecutiveFailures, 0, '探测失败不应累计连续失败次数');

    // 5) 探测结果必须挺过后续的模型同步。
    const resync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${openaiUpstream.body.id}/sync-models`, { method: 'POST', body: '{}' });
    assert.equal(resync.status, 200, JSON.stringify(resync.body));
    const afterResync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`);
    const resyncedModels = await catalogModels(afterResync, openaiUpstream.body.id);
    assert.deepEqual(resyncedModels.get('probe-model').thinkingLevels, ['low', 'medium'], '同步不应抹掉探测到的档位');
    assert.equal(resyncedModels.get('probe-model').thinkingSource, 'probe');
    assert.equal(resyncedModels.get('none-model').supportsThinking, false, '同步不应把探测为不支持的模型改回未知');
    assert.equal(resyncedModels.get('meta-model').thinkingSource, 'metadata');
    assert.ok(resyncedModels.get('probe-model').thinkingProbedAt, '同步不应丢掉探测时间');

    // 6) 单站探测接口：支持重跑，对不存在的上游返回 404。
    const single = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${openaiUpstream.body.id}/thinking-probe`, { method: 'POST', body: '{}' });
    assert.equal(single.status, 200, JSON.stringify(single.body));
    assert.equal(single.body.probed, 2, '单站探测应同样跳过元数据已声明的模型');
    assert.equal(single.body.failed, 1, '429 的模型应计入失败');
    assert.ok(single.body.catalog, '单站探测应返回最新模型目录');
    const missing = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/up_missing/thinking-probe`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404, JSON.stringify(missing.body));

    // 7) 请求体不是 JSON 时也要正常探测，而不是 500。
    const sloppy = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/thinking-probe`, { method: 'POST', body: 'not-json' });
    assert.equal(sloppy.status, 200, JSON.stringify(sloppy.body));

    // 8) 探测结论写入了配置文件。
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const persistedUpstream = persisted.upstreams.find((item) => item.id === openaiUpstream.body.id);
    const persistedEntry = persistedUpstream.modelCatalog.find((item) => item.id === 'probe-model');
    assert.deepEqual(persistedEntry.thinkingLevels, ['low', 'medium']);
    assert.equal(persistedEntry.thinkingSource, 'probe');

    // 9) 运行时生效：探测为不支持的模型，网关不再携带任何思考参数。
    const persistedConfig = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const localKey = persistedConfig.localApiKeys[0].key;
    const noneRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      body: JSON.stringify({ localModel: 'none-local', upstreamId: openaiUpstream.body.id, upstreamModel: 'none-model', thinkingLevel: 'high' })
    });
    assert.equal(noneRoute.status, 201, JSON.stringify(noneRoute.body));
    const served = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localKey}` },
      body: JSON.stringify({ model: 'none-local', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' })
    });
    assert.equal(served.status, 200, JSON.stringify(served.body));
    const forwarded = openai.chat.filter((item) => item.model === 'none-model').at(-1);
    assert.ok(forwarded, '请求应转发到上游');
    assert.equal(forwarded.effort, undefined, '探测为不支持思考的模型，客户端显式 reasoning_effort 也应被剥掉');

    // 10) 备份导入到全新配置时，探测结论不能丢。
    const backup = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/export`);
    assert.equal(backup.status, 200, JSON.stringify(backup.body).slice(0, 300));
    const removed = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${openaiUpstream.body.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const restored = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/import`, {
      method: 'POST',
      body: JSON.stringify({ ...backup.body, preserveCredentials: true })
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.body).slice(0, 400));
    const afterImport = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`);
    const importedModels = await catalogModels(afterImport, openaiUpstream.body.id);
    assert.deepEqual(importedModels.get('probe-model').thinkingLevels, ['low', 'medium'], '导入备份不应丢掉探测到的档位');
    assert.equal(importedModels.get('probe-model').supportsThinking, true, '导入备份不应丢掉探测结论');
    assert.equal(importedModels.get('probe-model').thinkingSource, 'probe');
    assert.equal(importedModels.get('none-model').supportsThinking, false);
    assert.equal(importedModels.get('meta-model').thinkingSource, 'metadata', '上游声明同样要保留');
    // 11) 探测期限覆盖响应头和正文；超时保留旧结论、释放 busy 状态且不污染指标。
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', body: JSON.stringify({ upstreamTimeoutMs: 1000 })
    });
    const timeoutUpstream = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', body: JSON.stringify({ name: 'probe-timeout', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'none', models: 'timeout-model' })
    });
    assert.equal(timeoutUpstream.status, 201);
    const timeoutUrl = `http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${timeoutUpstream.body.id}/thinking-probe`;
    const metricsBeforeTimeout = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`);
    for (const stage of ['headers', 'body']) {
      const previousCatalog = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`);
      const previous = (await catalogModels(previousCatalog, timeoutUpstream.body.id)).get('timeout-model');
      openai.timeoutMode = stage;
      const startedAt = Date.now();
      const timedOut = await requestJson(timeoutUrl, { method: 'POST', body: '{}', signal: AbortSignal.timeout(6000) });
      assert.equal(timedOut.status, 200, JSON.stringify(timedOut.body));
      assert.equal(timedOut.body.failed, 1, '正文超时应作为不确定探测结果，而非中断整个管理请求');
      assert.equal(timedOut.body.probed, 0);
      assert.equal(timedOut.body.models[0].message, '探测超时');
      assert.ok(Date.now() - startedAt >= 1500, '探测使用至少 2 秒的超时预算');
      const unchanged = (await catalogModels({ body: timedOut.body.catalog }, timeoutUpstream.body.id)).get('timeout-model');
      assert.equal(unchanged.supportsThinking, previous.supportsThinking);
      assert.deepEqual(unchanged.thinkingLevels, previous.thinkingLevels);
      assert.equal(unchanged.thinkingProbedAt, previous.thinkingProbedAt);
      for (let index = 0; index < 100 && openai.timeoutResponses.size; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(openai.timeoutResponses.size, 0, '超时必须关闭上游连接');
      openai.timeoutMode = null;
      const recovered = await requestJson(timeoutUrl, { method: 'POST', body: '{}', signal: AbortSignal.timeout(6000) });
      assert.equal(recovered.body.status, 'ok', '超时后不能一直 busy');
      assert.equal(recovered.body.supported, 1);
    }
    const metricsAfterTimeout = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`);
    assert.deepEqual(metricsAfterTimeout.body.totals, metricsBeforeTimeout.body.totals);
  } finally {
    for (const response of openai.timeoutResponses) response.destroy();
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    openai.server.closeAllConnections();
    anthropic.server.closeAllConnections();
    await Promise.all([new Promise((resolve) => openai.server.close(resolve)), new Promise((resolve) => anthropic.server.close(resolve))]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log('thinking probe integration tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
