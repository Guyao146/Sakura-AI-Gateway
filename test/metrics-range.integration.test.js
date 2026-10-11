const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-metrics-range-'));
const gatewayPort = 21600 + Math.floor(Math.random() * 1000);

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

async function main() {
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(gatewayPort) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const base = `http://127.0.0.1:${gatewayPort}`;
    const adminHeaders = {};
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };

    const upstream = await requestJson(`${base}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Range Upstream', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', authType: 'none', apiKey: '', models: 'range-model' })
    });
    assert.equal(upstream.status, 201, JSON.stringify(upstream.body));
    await requestJson(`${base}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ localModel: 'range-model', upstreamId: upstream.body.id, upstreamModel: 'range-model' })
    });

    const before = new Date(Date.now() - 60000).toISOString();
    const after = new Date(Date.now() + 60000).toISOString();
    const chat = await requestJson(`${base}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'range-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 })
    });
    assert.equal(chat.status, 502, JSON.stringify(chat.body));

    const missingParams = await requestJson(`${base}/api/admin/metrics/range`);
    assert.equal(missingParams.status, 400);
    assert.match(missingParams.body.error?.message || '', /时间范围参数无效/);
    const reversed = await requestJson(`${base}/api/admin/metrics/range?from=${encodeURIComponent(after)}&to=${encodeURIComponent(before)}`);
    assert.equal(reversed.status, 400);
    assert.match(reversed.body.error?.message || '', /开始时间不能晚于结束时间/);

    const inclusive = await requestJson(`${base}/api/admin/metrics/range?from=${encodeURIComponent(before)}&to=${encodeURIComponent(after)}`);
    assert.equal(inclusive.status, 200, JSON.stringify(inclusive.body));
    assert.equal(inclusive.body.matched, 1, '窗口应命中刚刚的失败请求');
    assert.equal(inclusive.body.totals.requests, 1);
    assert.equal(inclusive.body.totals.failed, 1);
    assert.equal(inclusive.body.totals.successful, 0);
    assert.ok(inclusive.body.byUpstream['Range Upstream'], '按上游统计应复用同一聚合口径');
    assert.equal(inclusive.body.byUpstream['Range Upstream'].requests, 1);

    const ancient = await requestJson(`${base}/api/admin/metrics/range?from=2020-01-01T00:00:00Z&to=2020-01-02T00:00:00Z`);
    assert.equal(ancient.status, 200);
    assert.equal(ancient.body.matched, 0);
    assert.deepEqual(ancient.body.totals, { requests: 0, successful: 0, failed: 0, failovers: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 });

    const stored = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'metrics.json'), 'utf8'));
    assert.ok(stored.totals.requests >= 1, '全量统计与范围统计互不影响');
    console.log('metrics range integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});