const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// 中转站与模型名的大小写合并：
// 同一个站列出 gpt-4o / GPT-4O 只留一行；不同站拼写不同也合并成一条选择；
// 显示名称沿用「当前名称」，转发时按各站自己的拼写发送；
// 只有大小写不同的重复选择要拒绝/合并，备份导入同样按大小写归一。
const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-model-case-'));
const gatewayPort = 25700 + Math.floor(Math.random() * 300);

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

function createOpenAIUpstream(modelIds, thinkingById = {}) {
  const state = { chat: [], modelIds, server: null };
  state.server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/v1/models') {
      jsonResponse(res, 200, { object: 'list', data: state.modelIds.map((id) => ({ id, object: 'model', owned_by: 'case', ...(thinkingById[id] || {}) })) });
      return;
    }
    if (req.url === '/v1/chat/completions') {
      state.chat.push({ model: body.model });
      // 把收到的模型名回显出来，便于断言网关发出去的是哪种拼写。
      jsonResponse(res, 200, {
        id: 'chatcmpl-case',
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `received:${body.model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: 'not found' } });
  });
  return state;
}

function localKeyFromDisk() {
  const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
  return persisted.localApiKeys[0].key;
}

function gatewayRequest(port, path, localKey, payload) {
  return requestJson(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${localKey}` },
    body: JSON.stringify(payload)
  });
}

async function main() {
  // 站点 A 自己就同时给出大小写不同的同一模型；站点 B 用另一种拼写。
  // /v1/models 同时声明能力：合并不能把上游声明和同步来源冲掉。
  const stationA = createOpenAIUpstream(['gpt-4o', 'GPT-4O', 'Mixed-Case', 'mixed-case'], {
    'gpt-4o': { supports_thinking: true },
    'GPT-4O': { supports_thinking: true }
  });
  const stationB = createOpenAIUpstream(['GPT-4O']);
  await new Promise((resolve) => stationA.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => stationB.server.listen(0, '127.0.0.1', resolve));
  const stationAPort = stationA.server.address().port;
  const stationBPort = stationB.server.address().port;

  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForOutput(gateway, '本地管理访问：无需认证');
    const base = `http://127.0.0.1:${gatewayPort}`;
    const settingsUpdate = await requestJson(`${base}/api/admin/settings`, {
      method: 'PUT', body: JSON.stringify({ upstreamTimeoutMs: 15000, upstreamRetries: 0, maxFallbackAttempts: 0, retryDelayMs: 0 })
    });
    assert.equal(settingsUpdate.status, 200, JSON.stringify(settingsUpdate.body));

    const addUpstream = (name, port) => requestJson(`${base}/api/admin/upstreams`, {
      method: 'POST', body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: '' })
    });
    const upstreamA = await addUpstream('case-a', stationAPort);
    const upstreamB = await addUpstream('case-b', stationBPort);
    assert.equal(upstreamA.status, 201, JSON.stringify(upstreamA.body));
    assert.equal(upstreamB.status, 201, JSON.stringify(upstreamB.body));

    // 1) 同一站点里大小写不同的模型合并成一条，名称用先出现的「当前名称」。
    const syncA = await requestJson(`${base}/api/admin/upstreams/${upstreamA.body.id}/sync-models`, { method: 'POST', body: '{}' });
    assert.equal(syncA.status, 200, JSON.stringify(syncA.body));
    assert.deepEqual(syncA.body.models, ['gpt-4o', 'Mixed-Case'], JSON.stringify(syncA.body.models));
    const syncB = await requestJson(`${base}/api/admin/upstreams/${upstreamB.body.id}/sync-models`, { method: 'POST', body: '{}' });
    assert.equal(syncB.status, 200, JSON.stringify(syncB.body));
    assert.deepEqual(syncB.body.models, ['GPT-4O'], JSON.stringify(syncB.body.models));

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const localKey = persisted.localApiKeys[0].key;
    assert.ok(localKey, '本地 Key 应已初始化');
    const persistedUpstreamA = persisted.upstreams.find((item) => item.id === upstreamA.body.id);
    assert.deepEqual(persistedUpstreamA.models, ['gpt-4o', 'Mixed-Case'], '落库的模型列表同样按大小写去重');
    assert.equal(persistedUpstreamA.modelCatalog.length, 2, '同一个站点不应留下大小写不同的两行');

    // 2) 用站点 B 的拼写保存选择，同时覆盖 A（A 里只有 gpt-4o）。
    const saved = await requestJson(`${base}/api/admin/model-selections`, {
      method: 'PUT',
      body: JSON.stringify({
        selections: [{
          upstreamId: upstreamA.body.id,
          upstreamIds: [upstreamA.body.id, upstreamB.body.id],
          upstreamMode: 'auto',
          upstreamModel: 'GPT-4O',
          localModel: 'case-local',
          thinkingLevel: 'auto',
          responsesMode: 'auto'
        }]
      })
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.selections.length, 1, '两个站点的大小写不同拼写合并成一条选择');
    assert.deepEqual(saved.body.selections[0].upstreamIds, [upstreamA.body.id, upstreamB.body.id]);

    const catalog = await requestJson(`${base}/api/admin/model-catalog`);
    const catalogRowA = catalog.body.upstreams.find((item) => item.id === upstreamA.body.id).models.find((item) => item.id === 'gpt-4o');
    const catalogRowB = catalog.body.upstreams.find((item) => item.id === upstreamB.body.id).models.find((item) => item.id === 'GPT-4O');
    assert.equal(catalogRowA.selection?.localModel, 'case-local', '选择应挂上本站大小写不同的模型');
    assert.equal(catalogRowB.selection?.localModel, 'case-local', '选择应挂上另一站点同名的模型');
    assert.equal(catalogRowA.supportsThinking, true, '大小写合并不该丢掉上游声明的思考能力');
    assert.equal(catalogRowA.thinkingSource, 'metadata', '合并后仍应标记为上游声明');
    assert.equal(catalogRowA.source, 'sync', '合并不该把同步来源改回 manual');
    assert.ok(catalogRowA.syncedAt, '合并不该丢掉同步时间');

    // 3) 运行时：请求走哪个站，那个站收到的就是自己的拼写。
    for (let index = 0; index < 4; index += 1) {
      const served = await gatewayRequest(gatewayPort, '/v1/chat/completions', localKey, { model: 'case-local', messages: [{ role: 'user', content: 'hi' }] });
      assert.equal(served.status, 200, JSON.stringify(served.body));
    }
    assert.ok(stationA.chat.length, '轮询应覆盖站点 A');
    assert.ok(stationB.chat.length, '轮询应覆盖站点 B');
    assert.equal(stationA.chat.every((item) => item.model === 'gpt-4o'), true, '站点 A 只应收到自己的拼写 gpt-4o');
    assert.equal(stationB.chat.every((item) => item.model === 'GPT-4O'), true, '站点 B 只应收到自己的拼写 GPT-4O');

    // 4) 手工路由用另一套大小写也要能建，并按站点真实拼写转发。
    const route = await requestJson(`${base}/api/admin/routes`, {
      method: 'POST',
      body: JSON.stringify({ localModel: 'mixed-local', upstreamId: upstreamA.body.id, upstreamModel: 'MIXED-CASE', thinkingLevel: 'auto' })
    });
    assert.equal(route.status, 201, JSON.stringify(route.body));
    const servedRoute = await gatewayRequest(gatewayPort, '/v1/chat/completions', localKey, { model: 'mixed-local', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(servedRoute.status, 200, JSON.stringify(servedRoute.body));
    assert.equal(stationA.chat.filter((item) => item.model === 'Mixed-Case').length, 1, '转发应使用站点自己的拼写 Mixed-Case');

    // 5) 同一模型提交两种拼写 = 重复选择。
    const duplicate = await requestJson(`${base}/api/admin/model-selections`, {
      method: 'PUT',
      body: JSON.stringify({
        selections: [
          { upstreamId: upstreamA.body.id, upstreamIds: [upstreamA.body.id], upstreamMode: 'fixed', upstreamModel: 'gpt-4o', localModel: 'case-local' },
          { upstreamId: upstreamB.body.id, upstreamIds: [upstreamB.body.id], upstreamMode: 'fixed', upstreamModel: 'GPT-4O', localModel: 'case-other' }
        ]
      })
    });
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body));
    assert.match(duplicate.body.error?.message || '', /模型重复选择/);

    // 6) 备份导入：选择换成另一种大小写仍要对得上，重复的两条合并成一条。
    //    先把选择固定到站点 A（仍用 A 站没有的拼写），保证后面的转发断言确定落在这一个站。
    const fixed = await requestJson(`${base}/api/admin/model-selections`, {
      method: 'PUT',
      body: JSON.stringify({
        selections: [{
          upstreamId: upstreamA.body.id,
          upstreamIds: [upstreamA.body.id],
          upstreamMode: 'fixed',
          upstreamModel: 'GPT-4O',
          localModel: 'case-local',
          thinkingLevel: 'auto',
          responsesMode: 'auto'
        }]
      })
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const backup = await requestJson(`${base}/api/admin/config/export`);
    assert.equal(backup.status, 200, JSON.stringify(backup.body).slice(0, 300));
    const importedBackup = JSON.parse(JSON.stringify(backup.body));
    const selection = importedBackup.config.modelSelections.find((item) => item.localModel === 'case-local');
    assert.ok(selection, '导出备份应包含模型选择');
    selection.upstreamModel = 'GPT-4o';
    const managedRoute = importedBackup.config.routes.find((item) => item.id === selection.managedRouteId);
    assert.ok(managedRoute, '模型选择应有托管路由');
    managedRoute.upstreamModel = 'GPT-4o';
    importedBackup.config.modelSelections.push({
      ...selection,
      id: 'selection_case_duplicate',
      upstreamModel: 'Gpt-4O',
      managedRouteId: null
    });
    const imported = await requestJson(`${base}/api/admin/config/import`, {
      method: 'POST', body: JSON.stringify({ ...importedBackup, preserveCredentials: true })
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body).slice(0, 400));
    assert.equal(imported.body.modelSelections.length, 1, '只有大小写不同的重复选择应合并成一条');
    assert.equal(imported.body.modelSelections[0].upstreamModel, 'GPT-4o', '合并后保留先出现的当前名称');
    assert.equal(
      imported.body.routes.filter((item) => item.managedBy === 'model-selector' && item.localModel === 'case-local').length,
      1,
      '重复的托管路由应被清理'
    );

    const afterImport = await requestJson(`${base}/api/admin/model-catalog`);
    const importedRowA = afterImport.body.upstreams.find((item) => item.id === upstreamA.body.id).models.find((item) => item.id === 'gpt-4o');
    assert.ok(importedRowA.selection, '导入后大小写不同的选择仍要挂到当前名称那行');
    const servedAfterImport = await gatewayRequest(gatewayPort, '/v1/chat/completions', localKey, { model: 'case-local', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(servedAfterImport.status, 200, JSON.stringify(servedAfterImport.body));
    assert.equal(stationA.chat.at(-1).model, 'gpt-4o', '导入后转发仍用站点自己的拼写');
  } finally {
    gateway.kill();
    stationA.server.close();
    stationB.server.close();
  }
}

main().then(() => {
  console.log('model case merge integration tests passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
