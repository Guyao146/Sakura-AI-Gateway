const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-selection-'));
const gatewayPort = 21000 + Math.floor(Math.random() * 1000);

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
  const observed = { openai: [], anthropic: [], modelHeaders: [], anthropicModelHeaders: [], openaiRequestHeaders: [], anthropicRequestHeaders: [] };
  const openai = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') {
      observed.modelHeaders.push(req.headers);
      jsonResponse(res, 200, {
        object: 'list',
        data: [
          { id: 'o3-mini', owned_by: 'mock', supports_thinking: true, reasoning_effort: ['low', 'medium', 'high'], supported_parameters: ['reasoning_effort'] },
          { id: 'gpt-plain', owned_by: 'mock', supports_thinking: false },
          { id: 'shared-model', owned_by: 'mock', supports_thinking: true }
        ]
      });
      return;
    }
    if (req.url === '/v1/chat/completions') {
      const body = JSON.parse(raw);
      observed.openai.push(body);
      observed.openaiRequestHeaders.push(req.headers);
      jsonResponse(res, 200, {
        id: 'selection-openai',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `openai-thinking:${body.reasoning_effort || 'none'}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  const anthropic = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/models') {
      observed.anthropicModelHeaders.push(req.headers);
      jsonResponse(res, 200, {
        data: [
          { id: 'claude-3-7-sonnet', capabilities: { thinking: true, thinking_levels: ['low', 'medium', 'high'] } },
          { id: 'shared-model', capabilities: { thinking: true, thinking_levels: ['low', 'medium', 'high'] } }
        ]
      });
      return;
    }
    if (req.url === '/v1/messages') {
      const body = JSON.parse(raw);
      observed.anthropic.push(body);
      observed.anthropicRequestHeaders.push(req.headers);
      jsonResponse(res, 200, {
        id: 'selection-anthropic',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `anthropic-budget:${body.thinking?.budget_tokens || 'none'}` }],
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
    const preview = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/preview`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'bearer', apiKey: 'preview-secret', clientIdentityPreset: 'cherry_studio' })
    });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.count, 3);
    assert.deepEqual(preview.body.models, ['gpt-plain', 'o3-mini', 'shared-model']);
    assert.equal(observed.modelHeaders.at(-1).authorization, 'Bearer preview-secret');
    assert.equal(observed.modelHeaders.at(-1)['user-agent'], 'CherryStudio');
    const configAfterPreview = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    assert.equal(configAfterPreview.body.upstreams.length, 0, '预览拉取不应提前保存上游');

    const invalidUserAgent = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'invalid-user-agent', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'shared-model', clientIdentityPreset: 'custom', customUserAgent: 'safe\r\ninjected: value' })
    });
    assert.equal(invalidUserAgent.status, 400, JSON.stringify(invalidUserAgent.body));

    const addUpstream = (name, port, protocol, models, authType = 'none', apiKey = '', identity = {}) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol, authType, apiKey, models, ...identity })
    });
    const openaiUpstream = await addUpstream('OpenAI Model Catalog', openaiPort, 'openai', 'o3-mini,gpt-plain,shared-model', 'bearer', 'saved-secret', { clientIdentityPreset: 'codex_cli' });
    const anthropicUpstream = await addUpstream('Anthropic Model Catalog', anthropicPort, 'anthropic', 'claude-3-7-sonnet,shared-model', 'none', '', { clientIdentityPreset: 'custom', customUserAgent: 'My-Anthropic-Client/1.0' });
    assert.equal(openaiUpstream.status, 201, output);
    assert.equal(anthropicUpstream.status, 201, output);
    assert.notEqual(openaiUpstream.body.apiKey, 'saved-secret', '上游 API Key 仍应保持脱敏');
    assert.match(openaiUpstream.body.apiKey, /••••/);
    assert.equal(openaiUpstream.body.clientIdentityPreset, 'codex_cli');
    assert.equal(anthropicUpstream.body.clientIdentityPreset, 'custom');
    assert.equal(anthropicUpstream.body.customUserAgent, 'My-Anthropic-Client/1.0');

    const anthropicTest = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams/${encodeURIComponent(anthropicUpstream.body.id)}/test`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(anthropicTest.status, 200, JSON.stringify(anthropicTest.body));
    assert.equal(observed.anthropicRequestHeaders.at(-1)['user-agent'], 'My-Anthropic-Client/1.0');

    const existingPreview = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/preview`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ upstreamId: openaiUpstream.body.id, baseUrl: `http://127.0.0.1:${openaiPort}/v1`, protocol: 'openai', authType: 'bearer', apiKey: '' })
    });
    assert.equal(existingPreview.status, 200, JSON.stringify(existingPreview.body));
    assert.equal(observed.modelHeaders.at(-1).authorization, 'Bearer saved-secret');
    assert.equal(observed.modelHeaders.at(-1)['user-agent'], 'codex_cli_rs');
    assert.equal(observed.modelHeaders.at(-1).originator, 'codex_cli_rs');

    const sync = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-catalog/sync`, {
      method: 'POST', headers: adminHeaders, body: '{}'
    });
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    const openaiCatalog = sync.body.catalog.upstreams.find((item) => item.id === openaiUpstream.body.id);
    const anthropicCatalog = sync.body.catalog.upstreams.find((item) => item.id === anthropicUpstream.body.id);
    assert.equal(openaiCatalog.models.find((item) => item.id === 'o3-mini').supportsThinking, true);
    assert.equal(openaiCatalog.models.find((item) => item.id === 'gpt-plain').supportsThinking, false);
    assert.equal(anthropicCatalog.models.find((item) => item.id === 'claude-3-7-sonnet').supportsThinking, true);
    assert.equal(observed.anthropicModelHeaders.at(-1)['user-agent'], 'My-Anthropic-Client/1.0');

    const selections = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-selections`, {
      method: 'PUT',
      headers: adminHeaders,
      body: JSON.stringify({ selections: [
        { upstreamId: openaiUpstream.body.id, upstreamModel: 'o3-mini', localModel: 'my-o3', thinkingLevel: 'high' },
        { upstreamId: anthropicUpstream.body.id, upstreamModel: 'claude-3-7-sonnet', localModel: 'my-claude', thinkingLevel: 'medium' },
        { upstreamId: openaiUpstream.body.id, upstreamIds: [openaiUpstream.body.id, anthropicUpstream.body.id], upstreamMode: 'auto', upstreamModel: 'shared-model', localModel: 'shared-local', thinkingLevel: 'low' }
      ] })
    });
    assert.equal(selections.status, 200, JSON.stringify(selections.body));
    assert.equal(selections.body.selectionMode, true);
    assert.equal(selections.body.selections.length, 3);
    const sharedSelection = selections.body.selections.find((item) => item.upstreamModel === 'shared-model');
    assert.equal(sharedSelection.upstreamMode, 'auto');
    assert.deepEqual(sharedSelection.upstreamIds, [openaiUpstream.body.id, anthropicUpstream.body.id]);

    const models = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/models`, { headers: localHeaders });
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.deepEqual(models.body.data.map((item) => item.id).sort(), ['my-claude', 'my-o3', 'shared-local']);

    const openaiRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-o3', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(openaiRequest.status, 200, JSON.stringify(openaiRequest.body));
    assert.equal(openaiRequest.body.choices[0].message.content, 'openai-thinking:high');
    assert.equal(observed.openai.at(-1).reasoning_effort, 'high');
    assert.equal(observed.openai.at(-1).thinkingLevel, undefined);
    assert.equal(observed.openaiRequestHeaders.at(-1)['user-agent'], 'codex_cli_rs');
    assert.equal(observed.openaiRequestHeaders.at(-1).originator, 'codex_cli_rs');
    assert.equal(observed.openaiRequestHeaders.at(-1).authorization, 'Bearer saved-secret');

    const explicitOverride = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-o3', reasoning_effort: 'low', messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(explicitOverride.status, 200, JSON.stringify(explicitOverride.body));
    assert.equal(observed.openai.at(-1).reasoning_effort, 'low');

    const anthropicRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'my-claude', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] })
    });
    assert.equal(anthropicRequest.status, 200, JSON.stringify(anthropicRequest.body));
    assert.equal(anthropicRequest.body.choices[0].message.content, 'anthropic-budget:4096');
    assert.equal(observed.anthropic.at(-1).thinking.type, 'enabled');
    assert.equal(observed.anthropic.at(-1).thinking.budget_tokens, 4096);
    assert.ok(observed.anthropic.at(-1).max_tokens >= 5120);
    assert.equal(observed.anthropicRequestHeaders.at(-1)['user-agent'], 'My-Anthropic-Client/1.0');

    const configWithAutomaticRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders });
    const automaticRoute = configWithAutomaticRoute.body.routes.find((item) => item.localModel === 'shared-local');
    assert.equal(automaticRoute.strategy, 'round_robin');
    assert.equal(automaticRoute.upstreamId, openaiUpstream.body.id);
    assert.deepEqual(automaticRoute.fallbackUpstreamIds, [anthropicUpstream.body.id]);

    const automaticFirst = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'shared-local', messages: [{ role: 'user', content: 'auto first' }] })
    });
    const automaticSecond = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'shared-local', messages: [{ role: 'user', content: 'auto second' }] })
    });
    assert.equal(automaticFirst.status, 200, JSON.stringify(automaticFirst.body));
    assert.equal(automaticSecond.status, 200, JSON.stringify(automaticSecond.body));
    assert.equal(automaticFirst.body.choices[0].message.content, 'openai-thinking:low');
    assert.equal(automaticSecond.body.choices[0].message.content, 'anthropic-budget:2048');

    const fixedSelections = selections.body.selections.map((item) => item.upstreamModel === 'shared-model'
      ? { ...item, upstreamId: anthropicUpstream.body.id, upstreamIds: [anthropicUpstream.body.id], upstreamMode: 'fixed' }
      : item);
    const fixedResult = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-selections`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ selections: fixedSelections })
    });
    assert.equal(fixedResult.status, 200, JSON.stringify(fixedResult.body));
    const fixedShared = fixedResult.body.selections.find((item) => item.upstreamModel === 'shared-model');
    assert.equal(fixedShared.upstreamMode, 'fixed');
    assert.deepEqual(fixedShared.upstreamIds, [anthropicUpstream.body.id]);
    const openAICountBeforeFixed = observed.openai.length;
    const anthropicCountBeforeFixed = observed.anthropic.length;
    const fixedRequest = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'shared-local', messages: [{ role: 'user', content: 'fixed provider' }] })
    });
    assert.equal(fixedRequest.status, 200, JSON.stringify(fixedRequest.body));
    assert.equal(fixedRequest.body.choices[0].message.content, 'anthropic-budget:2048');
    assert.equal(observed.openai.length, openAICountBeforeFixed, '固定 Anthropic 后不应请求 OpenAI 站点');
    assert.equal(observed.anthropic.length, anthropicCountBeforeFixed + 1);

    // 模型级接口协议偏好：chat 模式下 /v1/responses 请求必须直接走 Chat Completions，
    // 不能先打 /v1/responses 撞 404 再回退（mock 对 /v1/responses 一律返回 404）。
    const chatSelections = fixedResult.body.selections.concat([
      { upstreamId: openaiUpstream.body.id, upstreamModel: 'gpt-plain', localModel: 'my-plain-chat', responsesMode: 'chat' }
    ]);
    const chatResult = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/model-selections`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ selections: chatSelections })
    });
    assert.equal(chatResult.status, 200, JSON.stringify(chatResult.body));
    const chatSelection = chatResult.body.selections.find((item) => item.upstreamModel === 'gpt-plain');
    assert.equal(chatSelection.responsesMode, 'chat');
    const chatRoute = (await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config`, { headers: adminHeaders })).body.routes.find((item) => item.localModel === 'my-plain-chat');
    assert.equal(chatRoute.responsesMode, 'chat', '托管路由应继承模型选择的协议偏好');
    const chatBefore = observed.openai.length;
    const responsesViaChat = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'my-plain-chat', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'protocol-chat' }] }] })
    });
    assert.equal(responsesViaChat.status, 200, JSON.stringify(responsesViaChat.body));
    assert.equal(responsesViaChat.body.object, 'response', 'Chat 响应应被转换回 Responses 格式');
    assert.equal(observed.openai.length, chatBefore + 1, 'chat 模式应恰好发起一次 Chat Completions 请求');
    assert.deepEqual(observed.openai.at(-1).messages[0].content, [{ type: 'text', text: 'protocol-chat' }]);

    // 手工路由同样支持协议偏好，并校验非法值回退为 auto。
    const nativeRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ localModel: 'my-plain-native', upstreamId: openaiUpstream.body.id, upstreamModel: 'gpt-plain', responsesMode: 'native' })
    });
    assert.equal(nativeRoute.status, 201, JSON.stringify(nativeRoute.body));
    assert.equal(nativeRoute.body.responsesMode, 'native');
    const badRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ localModel: 'my-plain-bad', upstreamId: openaiUpstream.body.id, upstreamModel: 'gpt-plain', responsesMode: 'bogus' })
    });
    assert.equal(badRoute.status, 201, JSON.stringify(badRoute.body));
    assert.equal(badRoute.body.responsesMode, 'auto', '非法协议值应回退为 auto');

    // native 模式下即使上游 /v1/responses 返回 404 也不能悄悄回退到 Chat Completions。
    const nativeBefore = observed.openai.length;
    const nativeResponses = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'my-plain-native', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'protocol-native' }] }] })
    });
    assert.equal(nativeResponses.status, 404, JSON.stringify(nativeResponses.body));
    assert.equal(observed.openai.length, nativeBefore, 'native 模式不应回退到 Chat Completions');

    const exported = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/export`, { headers: adminHeaders });
    assert.equal(exported.status, 200, JSON.stringify(exported.body));
    assert.equal(exported.body.config.modelSelectionMode, true);
    assert.equal(exported.body.config.modelSelections.length, 4);

    const legacyBackup = JSON.parse(JSON.stringify(exported.body));
    const legacySharedSelection = legacyBackup.config.modelSelections.find((item) => item.upstreamModel === 'shared-model');
    const legacySharedRoute = legacyBackup.config.routes.find((item) => item.id === legacySharedSelection.managedRouteId);
    const duplicateSelectionId = 'selection_legacy_duplicate';
    const duplicateRouteId = 'route_legacy_duplicate';
    legacyBackup.config.modelSelections.push({
      ...legacySharedSelection,
      id: duplicateSelectionId,
      upstreamId: openaiUpstream.body.id,
      upstreamIds: undefined,
      upstreamMode: undefined,
      localModel: 'shared-legacy-alias',
      managedRouteId: duplicateRouteId
    });
    legacyBackup.config.routes.push({
      ...legacySharedRoute,
      id: duplicateRouteId,
      localModel: 'shared-legacy-alias',
      upstreamId: openaiUpstream.body.id,
      fallbackUpstreamIds: [],
      strategy: 'failover',
      upstreamWeights: { [openaiUpstream.body.id]: 1 },
      selectionId: duplicateSelectionId
    });
    const importedLegacy = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/config/import`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ ...legacyBackup, preserveCredentials: true })
    });
    assert.equal(importedLegacy.status, 200, JSON.stringify(importedLegacy.body));
    const mergedLegacySelections = importedLegacy.body.modelSelections.filter((item) => item.upstreamModel === 'shared-model');
    assert.equal(mergedLegacySelections.length, 1);
    assert.equal(mergedLegacySelections[0].upstreamMode, 'auto');
    assert.deepEqual(mergedLegacySelections[0].upstreamIds, [anthropicUpstream.body.id, openaiUpstream.body.id]);
    assert.equal(mergedLegacySelections[0].localModel, 'shared-local', '旧备份合并时应保留第一条别名');
    const mergedLegacyRoutes = importedLegacy.body.routes.filter((item) => item.upstreamModel === 'shared-model' && item.managedBy === 'model-selector');
    assert.equal(mergedLegacyRoutes.length, 1);
    assert.equal(mergedLegacyRoutes[0].strategy, 'round_robin');
    assert.deepEqual(mergedLegacyRoutes[0].fallbackUpstreamIds, [openaiUpstream.body.id]);
    console.log('model selection integration tests passed');
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