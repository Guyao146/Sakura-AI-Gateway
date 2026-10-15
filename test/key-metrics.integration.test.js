const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-key-metrics-http-'));
  let gateway;
  let base;
  let port;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    res.setHeader('Content-Type', 'application/json');
    if (body.model === 'key-fail') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: 'mock failure', type: 'invalid_request_error' } }));
      return;
    }
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      const chunk = (choices, usage) => `data: ${JSON.stringify({ id: 'chatcmpl-key-stream', object: 'chat.completion.chunk', model: body.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
      res.end(chunk([{ index: 0, delta: { role: 'assistant', content: 'stream ok' }, finish_reason: null }])
        + chunk([{ index: 0, delta: {}, finish_reason: 'stop' }])
        + chunk([], { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }) + 'data: [DONE]\n\n');
      return;
    }
    res.end(JSON.stringify({ id: 'chatcmpl-key', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'key metrics ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  const request = async (url, options = {}) => {
    const response = await fetch(`${base}${url}`, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, headers: response.headers, body, text };
  };
  const json = (url, body, headers = {}, method = 'POST') => request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const ok = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
  const stop = async () => {
    if (gateway && gateway.exitCode === null) { const exited = once(gateway, 'exit'); gateway.kill(); await exited; }
  };
  const start = async () => {
    let output = '';
    gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root,
      env: { ...process.env, SAKURA_AI_GATEWAY_DATA_DIR: temporary, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port),
        ADMIN_REMOTE_MODE: '', AUTHENTIK_ISSUER_URL: '', AUTHENTIK_CLIENT_ID: '', AUTHENTIK_CLIENT_SECRET: '', AUTHENTIK_REDIRECT_URI: '', AUTHENTIK_COOKIE_SECURE: 'false', TRUSTED_PROXY_ADDRESSES: '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', (chunk) => { output += chunk; });
    gateway.stderr.on('data', (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }).then((result) => result.ok, () => false)) return;
      assert.equal(gateway.exitCode, null, output);
      await pause(50);
    }
    throw new Error(`Gateway startup timed out: ${output}`);
  };

  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const reservation = http.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    await start();
    const first = ok(await request('/api/admin/config')).localApiKeys[0];
    const second = ok(await json('/api/admin/local-keys', { name: first.name }), 201).item;
    const unused = ok(await json('/api/admin/local-keys', { name: '未使用 Key' }), 201).item;
    assert.deepEqual(ok(await request('/api/admin/metrics')).byKey, {}, '新建 Key 不生成虚假用量');
    ok(await json('/api/admin/settings', { upstreamRetries: 0, retryDelayMs: 0 }, {}, 'PUT'));
    const added = ok(await json('/api/admin/upstreams', { name: 'Key Metrics Upstream', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
      protocol: 'openai', responsesMode: 'chat', authType: 'none', models: ['key-ok', 'key-fail'] }), 201);
    for (const model of ['key-ok', 'key-fail']) {
      ok(await json('/api/admin/routes', { localModel: model, upstreamId: added.id, upstreamModel: model }), 201);
    }
    const before = new Date(Date.now() - 60000).toISOString();
    const bearer = (key) => ({ Authorization: `Bearer ${key.key}` });
    const chat = { model: 'key-ok', messages: [{ role: 'user', content: 'test key stats' }] };
    ok(await json('/v1/chat/completions', chat, bearer(first)));
    ok(await json('/v1/messages', { ...chat, max_tokens: 32 }, { 'x-api-key': second.key, 'anthropic-version': '2023-06-01' }));
    assert.equal((await json('/v1/responses', { model: 'key-fail', input: 'failure' }, bearer(second))).status, 400);
    const streamed = await json('/v1/chat/completions', { ...chat, stream: true }, bearer(second));
    assert.equal(streamed.status, 200, streamed.text);
    assert.match(streamed.text, /stream ok/);
    assert.match(streamed.text, /\[DONE\]/);

    let snapshot = ok(await request('/api/admin/metrics'));
    assert.deepEqual(snapshot.totals, { requests: 4, successful: 3, failed: 1, failovers: 0, promptTokens: 13, completionTokens: 7, totalTokens: 20 });
    assert.equal(snapshot.byKey[first.id].requests, 1);
    assert.equal(snapshot.byKey[first.id].totalTokens, 5);
    assert.equal(snapshot.byKey[second.id].requests, 3);
    assert.equal(snapshot.byKey[second.id].successful, 2);
    assert.equal(snapshot.byKey[second.id].failed, 1);
    assert.equal(snapshot.byKey[second.id].totalTokens, 15, '包含流式末尾 usage-only 帧用量');
    assert.equal(snapshot.byKey[first.id].keyName, snapshot.byKey[second.id].keyName, '同名 Key 仍按 ID 分开统计');
    assert.equal(snapshot.byKey[unused.id], undefined);
    const rangeQuery = new URLSearchParams({ from: before, to: new Date(Date.now() + 60000).toISOString() });
    const ranged = ok(await request(`/api/admin/metrics/range?${rangeQuery}`));
    assert.deepEqual(ranged.byKey, snapshot.byKey);
    assert.equal(ranged.matched, 4);
    assert.deepEqual(ok(await request('/api/admin/metrics/range?from=2020-01-01&to=2020-01-02')).byKey, {});
    for (const key of [first, second, unused]) assert.equal(JSON.stringify(snapshot).includes(key.key), false, '统计与明细均不得泄露 Key 内容');

    ok(await json(`/api/admin/local-keys/${second.id}`, { name: '改名后的 Key' }, {}, 'PUT'));
    ok(await json('/v1/responses', { model: 'key-ok', input: 'renamed key' }, bearer(second)));
    snapshot = ok(await request('/api/admin/metrics'));
    assert.equal(snapshot.byKey[second.id].requests, 4, '改名不能拆分已有统计');
    assert.equal(snapshot.byKey[second.id].keyName, '改名后的 Key');
    assert.equal(snapshot.byKey[second.id].totalTokens, 20);
    ok(await json(`/api/admin/local-keys/${second.id}`, { enabled: false }, {}, 'PUT'));
    assert.equal((await json('/v1/chat/completions', chat, bearer(second))).status, 401);
    ok(await request(`/api/admin/local-keys/${second.id}`, { method: 'DELETE' }));
    assert.deepEqual(ok(await request('/api/admin/metrics')).byKey, snapshot.byKey, '停用和删除 Key 都保留历史，鉴权拒绝不额外计数');
    const exported = ok(await request('/api/admin/metrics/export?scope=all'));
    assert.deepEqual(exported.byKey, snapshot.byKey, '导出文件包含分 Key 汇总');
    assert.equal(exported.records.length, 5);
    for (const key of [first, second, unused]) assert.equal(JSON.stringify(exported).includes(key.key), false);

    await stop();
    await start();
    assert.deepEqual(ok(await request('/api/admin/metrics')).byKey, snapshot.byKey, '删除 Key 后重启仍保留其统计');
    assert.deepEqual(ok(await request('/api/admin/metrics', { method: 'DELETE' })).byKey, {});
    const imported = ok(await json('/api/admin/metrics/import', exported));
    assert.equal(imported.imported, 5);
    assert.deepEqual(imported.metrics.byKey, snapshot.byKey, 'HTTP 导出/清空/导入往返不丢 Token 和 Key');
    assert.deepEqual(imported.metrics.totals, snapshot.totals);
    const duplicate = ok(await json('/api/admin/metrics/import', exported));
    assert.equal(duplicate.imported, 0);
    assert.equal(duplicate.duplicates, 5);
    assert.deepEqual(duplicate.metrics.byKey, snapshot.byKey);

    ok(await json('/api/admin/admin-auth/users', { username: 'metrics-admin', password: 'metrics-password-123' }), 201);
    ok(await json('/api/admin/admin-auth/remote-mode', { remoteMode: 'password', requireLocalLogin: true }, {}, 'PUT'));
    for (const endpoint of ['/api/admin/metrics', `/api/admin/metrics/range?${rangeQuery}`, '/api/admin/metrics/export?scope=all', '/api/admin/metrics/keys']) {
      assert.equal((await request(endpoint)).status, 401, '分 Key 统计必须经过管理鉴权');
      assert.equal((await request(endpoint, { headers: bearer(first) })).status, 401, '模型 Key 不能代替管理员会话查看统计');
    }
    const login = await json('/auth/password/login', { username: 'metrics-admin', password: 'metrics-password-123' });
    ok(login);
    const adminHeaders = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: base };
    assert.deepEqual(ok(await request('/api/admin/metrics', { headers: adminHeaders })).byKey, snapshot.byKey);
    assert.deepEqual(ok(await request('/api/admin/metrics', { method: 'DELETE', headers: adminHeaders })).byKey, {});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(temporary, 'metrics.json'), 'utf8')).byKey, {});
    console.log('key metrics integration tests passed (three protocols, streaming, key lifecycle, export/import, admin isolation)');
  } finally {
    await stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });