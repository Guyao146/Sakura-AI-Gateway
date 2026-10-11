const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { mergeModelsById } = require('../public/model-groups');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-upstream-cleanup-'));
const gatewayPort = 21400 + Math.floor(Math.random() * 1000);

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, (response) => {
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

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

function jsonResponse(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function main() {
  const observed = { anthropic: [] };
  const openai = http.createServer(async (req, res) => jsonResponse(res, 404, { error: { message: 'not found' } }));
  const anthropic = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/messages') {
      const body = JSON.parse(raw || '{}');
      observed.anthropic.push(body);
      jsonResponse(res, 200, {
        id: 'cleanup-anthropic',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: 'upstream-cleanup-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 5 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  await new Promise((resolve) => openai.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
  const openaiPort = openai.address().port;
  const anthropicPort = anthropic.address().port;
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
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const openaiUpstream = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'OpenAI Cleanup', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'bearer', apiKey: 'saved-secret', models: 'o3-mini,shared-model' })
    });
    const anthropicUpstream = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Anthropic Cleanup', baseUrl: `http://127.0.0.1:${anthropicPort}/v1`, protocol: 'anthropic', authType: 'none', apiKey: '', models: 'claude-3-7-sonnet,shared-model' })
    });
    assert.equal(openaiUpstream.status, 201, JSON.stringify(openaiUpstream.body));
    assert.equal(anthropicUpstream.status, 201, JSON.stringify(anthropicUpstream.body));
    const openaiId = openaiUpstream.body.id;
    const anthropicId = anthropicUpstream.body.id;

    const selections = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-selections`, {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ selections: [
        { upstreamId: openaiId, upstreamModel: 'o3-mini', localModel: 'my-o3', thinkingLevel: 'auto' },
        { upstreamId: anthropicId, upstreamModel: 'claude-3-7-sonnet', localModel: 'my-claude', thinkingLevel: 'auto' },
        { upstreamId: openaiId, upstreamIds: [openaiId, anthropicId], upstreamMode: 'auto', upstreamModel: 'shared-model', localModel: 'shared-local', thinkingLevel: 'auto' }
      ] })
    });
    assert.equal(selections.status, 200, JSON.stringify(selections.body));

    // 停用中转：模型目录不再展示它的模型，但已保存的模型选择原样保留（停用是临时的）。
    const disableBody = JSON.stringify({ name: 'OpenAI Cleanup', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'bearer', apiKey: '', models: 'o3-mini,shared-model', enabled: false });
    const disabled = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(openaiId)}`, {
      method: 'PUT', headers: adminHeaders, body: disableBody
    });
    assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
    const disabledCatalog = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`, { headers: adminHeaders });
    const disabledOpenai = disabledCatalog.body.upstreams.find((item) => item.id === openaiId);
    assert.equal(disabledOpenai.enabled, false);
    assert.equal(disabledOpenai.models.length, 0, '停用中转的模型不应再出现在模型目录');
    const disabledAnthropic = disabledCatalog.body.upstreams.find((item) => item.id === anthropicId);
    assert.deepEqual(disabledAnthropic.models.map((model) => model.id), ['claude-3-7-sonnet', 'shared-model']);
    assert.equal(disabledCatalog.body.selections.length, 3, '停用不应删除已保存的模型选择');
    const mergedDisabled = mergeModelsById(disabledCatalog.body.upstreams).map((model) => model.id);
    assert.ok(!mergedDisabled.includes('o3-mini'), '前端合并视图不应再出现停用中转独有的模型');
    // shared-model 两个站都提供：停用 OpenAI 站后仍由 Anthropic 站展示，且其 provider 只剩一个。
    const sharedMerged = mergeModelsById(disabledCatalog.body.upstreams).find((model) => model.id === 'shared-model');
    assert.ok(sharedMerged, '共享模型仍由剩余启用站提供');
    assert.deepEqual(sharedMerged.providers.map((provider) => provider.id), [anthropicId]);
    assert.ok(mergedDisabled.includes('claude-3-7-sonnet'));

    // 重新启用后模型目录恢复。
    const reenabled = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(openaiId)}`, {
      method: 'PUT', headers: adminHeaders,
      body: JSON.stringify({ name: 'OpenAI Cleanup', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'bearer', apiKey: '', models: 'o3-mini,shared-model', enabled: true })
    });
    assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
    const reenabledCatalog = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog`, { headers: adminHeaders });
    const reenabledOpenai = reenabledCatalog.body.upstreams.find((item) => item.id === openaiId);
    assert.deepEqual(reenabledOpenai.models.map((model) => model.id), ['o3-mini', 'shared-model']);

    // 删除中转：引用它的本地模型选择一起清理。
    const deleted = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(openaiId)}`, {
      method: 'DELETE', headers: adminHeaders
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const after = deleted.body;
    assert.ok(!after.upstreams.some((item) => item.id === openaiId));
    assert.ok(!after.modelSelections.some((item) => item.localModel === 'my-o3'), '只属于被删中转的本地模型选择应删除');
    const shared = after.modelSelections.find((item) => item.localModel === 'shared-local');
    assert.ok(shared, '多站共享的本地模型选择应保留');
    assert.deepEqual(shared.upstreamIds, [anthropicId]);
    assert.equal(shared.upstreamMode, 'fixed', '只剩一个来源站时应降级为固定站');
    assert.equal(shared.upstreamId, anthropicId);
    const sharedRoute = after.routes.find((item) => item.id === shared.managedRouteId);
    assert.ok(sharedRoute, '共享模型的托管路由应重建到剩余来源站');
    assert.equal(sharedRoute.upstreamId, anthropicId);
    assert.deepEqual(sharedRoute.fallbackUpstreamIds, []);
    assert.equal(sharedRoute.strategy, 'failover');
    assert.equal(sharedRoute.managedBy, 'model-selector');
    assert.ok(!Object.keys(sharedRoute.upstreamWeights || {}).includes(openaiId), '托管路由权重不应再含被删中转');
    assert.ok(!after.routes.some((item) => item.managedBy === 'model-selector' && item.localModel === 'my-o3'), '被删本地模型的托管路由应删除');

    // 客户端看到的本地模型列表同步更新。
    const models = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: localHeaders });
    const modelIds = (models.body.data || []).map((item) => item.id);
    assert.ok(!modelIds.includes('my-o3'), '被删中转独有的本地模型不应再列出');
    assert.ok(modelIds.includes('my-claude'));
    assert.ok(modelIds.includes('shared-local'));

    // 重建后的托管路由真正可用：shared-local 经剩余的 Anthropic 站转发。
    const chat = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'shared-local', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 })
    });
    assert.equal(chat.status, 200, JSON.stringify(chat.body));
    assert.equal(chat.body.choices?.[0]?.message?.content, 'upstream-cleanup-ok');
    assert.equal(observed.anthropic.at(-1).model, 'shared-model');

    // 清理结果已持久化。
    const stored = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    assert.equal(stored.upstreams.length, 1);
    assert.ok(!stored.modelSelections.some((item) => item.localModel === 'my-o3'));
    const storedShared = stored.modelSelections.find((item) => item.localModel === 'shared-local');
    assert.equal(storedShared.upstreamMode, 'fixed');
    assert.ok(!stored.routes.some((route) => route.localModel === 'my-o3'));
    console.log('upstream cleanup integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await Promise.all([
      new Promise((resolve) => openai.close(resolve)),
      new Promise((resolve) => anthropic.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
