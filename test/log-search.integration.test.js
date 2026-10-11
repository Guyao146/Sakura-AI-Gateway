const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-log-search-'));
const gatewayPort = 19500 + Math.floor(Math.random() * 500);

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
    const timer = setTimeout(() => reject(new Error('等待网关启动超时：' + output)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(text)) { clearTimeout(timer); process.stdout.removeListener('data', onData); resolve(output); }
    };
    process.stdout.on('data', onData);
    process.once('exit', (code) => { clearTimeout(timer); reject(new Error('网关退出：' + code)); });
  });
}

async function main() {
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.url === '/v1/chat/completions') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id: 'chat-result', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ object: 'list', data: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const localKey = config.localApiKeys[0].key;
    const keyId = config.localApiKeys[0].id;
    const add = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name: 'search-upstream', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'openai', responsesMode: 'chat', authType: 'none', apiKey: '', models: 'upstream-model' })
    });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ localModel: 'search-local', upstreamId: add.body.id, upstreamModel: 'upstream-model' })
    });
    assert.equal(route.status, 201, JSON.stringify(route.body));

    // 真实模型请求：最后一条用户消息应进入日志成为可搜索内容。
    const response = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${localKey}`, 'x-request-id': 'log-search-001' },
      body: JSON.stringify({
        model: 'search-local',
        messages: [
          { role: 'system', content: '你是助手' },
          { role: 'user', content: '帮我规划一次东京旅行，预算五千元' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '请加入筑地市场的行程' }
        ]
      })
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const byKeyword = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?keyword=${encodeURIComponent('筑地市场')}`);
    assert.equal(byKeyword.status, 200, JSON.stringify(byKeyword.body));
    assert.equal(byKeyword.body.total, 1, '按内容关键字应命中 1 条');
    const item = byKeyword.body.items[0];
    assert.equal(item.id, 'log-search-001');
    assert.ok(item.contentDigest.includes('筑地市场'), '内容摘要应包含最后一条用户消息：' + item.contentDigest);
    assert.equal(item.contentDigest.includes('东京旅行'), false, '内容摘要只保留最后一条用户消息');
    assert.equal(item.keyId, keyId, '日志应记录来源 Key ID');
    assert.ok(item.keyName, '日志应记录来源 Key 名称');

    const byKey = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?keyId=${encodeURIComponent(keyId)}`);
    assert.equal(byKey.status, 200);
    assert.equal(byKey.body.total, 1, '按 Key 筛选应命中 1 条');

    const future = new Date(Date.now() + 3600 * 1000).toISOString();
    const past = new Date(Date.now() - 3600 * 1000).toISOString();
    const byRange = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?from=${encodeURIComponent(past)}&to=${encodeURIComponent(future)}`);
    assert.equal(byRange.status, 200);
    assert.equal(byRange.body.total, 1, '按时间段筛选应命中 1 条');
    assert.ok(byRange.body.filters.from && byRange.body.filters.to, '响应应回传规范化后的筛选条件');

    const noHit = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?keyword=${encodeURIComponent('不存在的关键字')}`);
    assert.equal(noHit.status, 200);
    assert.equal(noHit.body.total, 0, '无匹配关键字应返回 0 条');

    const keys = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/keys`);
    assert.equal(keys.status, 200, JSON.stringify(keys.body));
    assert.ok(keys.body.keys.some((entry) => entry.keyId === keyId), 'Key 列表应包含发起过请求的 Key');
    assert.equal(JSON.stringify(keys.body).includes(localKey), false, 'Key 列表不得返回完整本地 Key');

    const invalid = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?from=not-a-date&to=${encodeURIComponent(future)}`);
    assert.equal(invalid.status, 400, '非法时间参数应返回 400');

    console.log('log search integration tests passed');
  } finally {
    upstream.close();
    gateway.kill('SIGKILL');
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
