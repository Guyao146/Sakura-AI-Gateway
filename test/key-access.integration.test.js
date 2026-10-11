const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-access-'));
const observed = [];
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  observed.push({ path: req.url, body });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ id: 'chatcmpl-access', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
let gateway;
let base;
let port;
async function request(url, method = 'GET', body, key, headers = {}) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function stopGateway() {
  if (!gateway || gateway.exitCode !== null) return;
  const exited = once(gateway, 'exit');
  gateway.kill();
  await exited;
}
async function startGateway() {
  gateway = spawn(process.execPath, ['src/server.js'], { cwd: projectRoot,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`启动超时：${output}`)); }, 10000);
    const poll = setInterval(() => {
      if (output.includes('本地管理访问：无需认证')) { clearInterval(poll); clearTimeout(timer); resolve(); }
      else if (gateway.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error(output)); }
    }, 25);
    gateway.once('error', (error) => { clearInterval(poll); clearTimeout(timer); reject(error); });
  });
}
const payloadFor = (endpoint, model, stream = false) => endpoint === 'responses'
  ? { model, input: 'hi', stream }
  : { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream };
async function main() {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  try {
    await startGateway();
    for (const file of ['model-groups.js', 'key-access.js', 'app.js']) {
      const response = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200, `${file} 必须能被浏览器加载`);
      assert.match(response.headers.get('content-type'), /application\/javascript/);
      assert.equal(await response.text(), fs.readFileSync(path.join(projectRoot, 'public', file), 'utf8'));
    }
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const fullKey = persisted.localApiKeys[0].key;
    const added = await request('/api/admin/upstreams', 'POST', { name: 'access-test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: 'openai', authType: 'none', models: ['gpt-one', 'GPT-ONE', 'gpt-two', 'claude-one'], responsesMode: 'chat' });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const upstreamId = added.body.id;
    const route = async (localModel, upstreamModel) => {
      const result = await request('/api/admin/routes', 'POST', { localModel, upstreamModel, upstreamId });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body;
    };
    await route('assistant', 'gpt-one');
    await route('other-alias', 'gpt-one');
    const list = async (key) => {
      const result = await request('/v1/models', 'GET', undefined, key);
      assert.equal(result.status, 200);
      return result.body.data.map((item) => item.id);
    };
    assert.deepEqual(await list(fullKey), ['assistant', 'other-alias', 'gpt-one', 'gpt-two', 'claude-one']);
    const made = await request('/api/admin/local-keys', 'POST', { name: 'restricted', modelAccessMode: 'custom', allowedGroups: [' GPT ', 'gpt'], allowedModels: ['assistant', 'ASSISTANT', 'gpt-two'] });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const key = made.body.item;
    assert.deepEqual(key.allowedGroups, ['gpt']);
    assert.deepEqual(key.allowedModels, ['assistant', 'gpt-two']);
    assert.deepEqual(await list(key.key), ['assistant', 'gpt-two']);
    const endpoints = ['chat/completions', 'messages', 'responses'];
    const denied = async (model, token = key.key) => {
      const count = observed.length;
      for (const endpoint of endpoints) for (const stream of [false, true]) {
        const result = await request(`/v1/${endpoint}`, 'POST', payloadFor(endpoint, model, stream), token, { 'x-request-id': 'access-denied-test' });
        assert.equal(result.status, 403, `${model}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.error.code, 'model_not_allowed');
        assert.equal(result.body.error.type, 'permission_error');
        assert.equal(result.headers.get('x-request-id'), 'access-denied-test');
      }
      assert.equal(observed.length, count, '拒绝的请求不能到上游');
    };
    for (const model of ['gpt-one', 'other-alias', 'claude-one', 'unknown']) await denied(model);
    for (const endpoint of endpoints) {
      const result = await request(`/v1/${endpoint}`, 'POST', payloadFor(endpoint, 'ASSISTANT'), key.key);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(observed.at(-1).body.model, 'gpt-one', '大小写别名也必须使用同一条路由');
    }
    const apiKeyHeader = await request('/v1/messages', 'POST', payloadFor('messages', 'assistant'), undefined, { 'x-api-key': key.key });
    assert.equal(apiKeyHeader.status, 200);
    const missing = await request('/v1/chat/completions', 'POST', { messages: [] }, key.key);
    assert.equal(missing.status, 400, '缺少 model 仍然是参数错误');
    const update = async (body) => {
      const result = await request(`/api/admin/local-keys/${key.id}`, 'PUT', body);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    await update({ enabled: false });
    const renamed = await update({ name: 'renamed' });
    assert.equal(renamed.enabled, false, '仅改名称不重新启用 Key');
    assert.deepEqual(renamed.allowedModels, key.allowedModels);
    assert.equal((await request('/v1/models', 'GET', undefined, key.key)).status, 401);
    await update({ enabled: true });
    assert.deepEqual(await list(key.key), ['assistant', 'gpt-two']);
    await update({ allowedGroups: [] });
    assert.deepEqual(await list(key.key), []);
    await denied('assistant');
    await update({ allowedGroups: ['gpt'], allowedModels: [] });
    await denied('assistant');
    await update({ allowedModels: key.allowedModels });
    for (const body of [{ modelAccessMode: 'oops' }, { allowedGroups: 'gpt' }, { allowedModels: [null] }, { allowedModels: null }]) {
      assert.equal((await request(`/api/admin/local-keys/${key.id}`, 'PUT', body)).status, 400);
      assert.equal((await request('/api/admin/local-keys', 'POST', body)).status, 400);
    }
    assert.deepEqual(await list(key.key), ['assistant', 'gpt-two'], '无效更新不能改变权限');
    await route('*', 'claude-one');
    await denied('unknown');
    await denied('gpt-two');
    assert.deepEqual(await list(key.key), ['assistant'], '通配路由目标改变时列表也按目标分组过滤');
    const saved = await request('/api/admin/model-selections', 'PUT', { selections: [{ upstreamId, upstreamModel: 'gpt-two', localModel: 'selected', responsesMode: 'chat' }] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await update({ allowedModels: ['selected'] });
    assert.deepEqual(await list(key.key), ['selected']);
    await denied('gpt-two');
    assert.equal((await request('/v1/responses', 'POST', payloadFor('responses', 'selected'), key.key)).status, 200);
    const backup = await request('/api/admin/config/export');
    const restoredKey = backup.body.config.localApiKeys.find((item) => item.id === key.id);
    assert.deepEqual(restoredKey.allowedModels, ['selected']);
    await update({ allowedModels: [] });
    assert.equal((await request('/api/admin/config/import', 'POST', { ...backup.body, preserveCredentials: true })).status, 200);
    assert.deepEqual(await list(key.key), [], '保留凭据也保留当前权限');
    restoredKey.allowedGroups = [' GPT ', 'gpt'];
    restoredKey.allowedModels = [' SELECTED ', 'selected'];
    assert.equal((await request('/api/admin/config/import', 'POST', { ...backup.body, preserveCredentials: false })).status, 200);
    assert.deepEqual(await list(key.key), ['selected']);
    const invalidBackup = JSON.parse(JSON.stringify(backup.body));
    invalidBackup.config.localApiKeys.find((item) => item.id === key.id).modelAccessMode = 'typo';
    assert.equal((await request('/api/admin/config/import', 'POST', { ...invalidBackup, preserveCredentials: false })).status, 400);
    assert.deepEqual(await list(key.key), ['selected'], '无效导入应原子拒绝');
    // 无权限字段的旧备份、落盘后重启，以及其他 Key 的权限隔离。
    delete backup.body.config.localApiKeys[0].modelAccessMode;
    delete backup.body.config.localApiKeys[0].allowedGroups;
    delete backup.body.config.localApiKeys[0].allowedModels;
    assert.equal((await request('/api/admin/config/import', 'POST', { ...backup.body, preserveCredentials: false })).status, 200);
    assert.ok((await list(fullKey)).includes('other-alias'));
    await stopGateway();
    await startGateway();
    assert.deepEqual(await list(key.key), ['selected']);
    await denied('other-alias');
    await update({ modelAccessMode: 'all' });
    assert.deepEqual(await list(key.key), await list(fullKey));
    await update({ modelAccessMode: 'custom' });
    assert.deepEqual(await list(key.key), ['selected'], '切换模式保留勾选');
    console.log('key access integration tests passed');
  } finally {
    await stopGateway();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
