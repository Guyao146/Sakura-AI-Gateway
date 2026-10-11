const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-output-guard-'));
const gatewayPort = 24000 + Math.floor(Math.random() * 1000);

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const requestObject = http.request(url, { ...options, headers: { ...(options.headers || {}) } }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: raw }));
    });
    requestObject.on('error', reject);
    if (options.body) requestObject.write(options.body);
    requestObject.end();
  });
}

function requestJson(url, options = {}) {
  return request(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }).then((result) => ({ ...result, json: result.body ? JSON.parse(result.body) : {} }));
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待启动超时：${output}`)), 10000);
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

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

// 这条测试专门覆盖“上游在 Chat 流里直接返回非字符串 id”的原始透传场景。
// 该路径不经任何协议转换，只能靠输出层的兜底归一化救回来——正是客户端报
// Expected 'id' to be a string. 的典型现场。
async function main() {
  let override;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (override) return override(req, res, JSON.parse(raw || '{}'));
    if (req.url !== '/v1/chat/completions') {
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    const body = JSON.parse(raw);
    res.setHeader('Content-Type', 'text/event-stream');
    // 故意用数字 id（部分聚合站的真实行为）。
    writeSse(res, { id: 99901, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    // 再混一个 null id：客户端 SDK 对必填 id 报 Expected 'id' to be a string. 的另一种形态。
    writeSse(res, { id: null, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'guarded' }, finish_reason: null }] });
    writeSse(res, { id: 99903, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    writeSse(res, '[DONE]');
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const added = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'loose-id-upstream', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'openai', authType: 'none', apiKey: '', models: 'guarded-model' })
    });
    assert.equal(added.status, 201);
    const response = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { ...localHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'guarded-model', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(response.status, 200, response.body);
    // 逐帧校验：每个 chunk 的 id 都必须是字符串。
    const chunks = response.body.split(/\r?\n\r?\n/)
      .map((frame) => frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
      .filter((data) => data && data !== '[DONE]')
      .map((data) => JSON.parse(data));
    assert.ok(chunks.length >= 3, `应至少透传 3 个 chunk，实际 ${chunks.length}`);
    for (const chunk of chunks) {
      assert.equal(typeof chunk.id, 'string', `透传 chunk.id 必须是字符串，实际为 ${JSON.stringify(chunk.id)}`);
    }
    assert.ok(!response.body.includes('"id": 99901'), '原始数字 id 不应出现在客户端输出中');
    assert.ok(!response.body.includes('"id": null'), 'null id 不应出现在客户端输出中');
    // 告警应写入诊断日志，便于事后定位是哪一帧、哪个字段被修正了。
    const logs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=20`, { headers: adminHeaders });
    assert.equal(logs.status, 200);
    const entry = (logs.json.items || []).find((item) => item.model === 'guarded-model');
    assert.ok(entry, '应能在请求日志中找到该请求');
    assert.ok(entry.diagnostics, '该请求应携带诊断信息');
    assert.ok((entry.diagnostics.warnings || []).some((message) => message.includes('非字符串 id')), `应记录非字符串 id 的告警，实际：${JSON.stringify(entry.diagnostics.warnings)}`);
    // 工具参数必须无损：Anthropic 原生和 Chat 转换、JSON 和 SSE 都要覆盖。
    const toolInput = { id: 123, record: { id: { tenant: 'acme', key: 7 }, call_id: null }, rows: [{ item_id: false }] };
    override = (req, res, body) => {
      const native = req.url === '/v1/messages';
      if (!native && req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'endpoint not found' } }));
      }
      const tool = { type: 'tool_use', id: 789, name: 'lookup', input: toolInput };
      const call = { id: 789, type: 'function', function: { name: 'lookup', arguments: JSON.stringify(toolInput) } };
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(native
          ? { id: 456, type: 'message', content: [tool], stop_reason: 'tool_use' }
          : { id: 456, choices: [{ message: { role: 'assistant', tool_calls: [call] }, finish_reason: 'tool_calls' }] }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      if (native) {
        writeSse(res, { type: 'message_start', message: { id: 456, content: [], usage: { input_tokens: 1, output_tokens: 0 } } }, 'message_start');
        writeSse(res, { type: 'content_block_start', index: 0, content_block: tool }, 'content_block_start');
        writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
        writeSse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, 'message_delta');
        writeSse(res, { type: 'message_stop' }, 'message_stop');
      } else {
        writeSse(res, { id: 456, choices: [{ delta: { tool_calls: [{ index: 0, ...call }] }, finish_reason: 'tool_calls' }] });
        writeSse(res, '[DONE]');
      }
      res.end();
    };
    const anthropic = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', body: JSON.stringify({ name: 'native-anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'anthropic', authType: 'none', models: 'guarded-anthropic-model' })
    });
    assert.equal(anthropic.status, 201);
    for (const model of ['guarded-model', 'guarded-anthropic-model']) {
      for (const stream of [false, true]) {
        const requestId = `tool-input-${model}-${stream}`;
        const result = await request(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
          method: 'POST', headers: { ...localHeaders, 'Content-Type': 'application/json', 'x-request-id': requestId },
          body: JSON.stringify({ model, stream, max_tokens: 32, messages: [{ role: 'user', content: 'lookup' }] })
        });
        assert.equal(result.status, 200, result.body);
        if (stream) {
          const events = result.body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
          const tool = events.find((event) => event.type === 'content_block_start').content_block;
          assert.equal(tool.id, '789', '真正的协议 ID 仍须规范化');
          const deltas = events.filter((event) => event.delta?.type === 'input_json_delta').map((event) => event.delta.partial_json).join('');
          assert.deepEqual(deltas ? JSON.parse(deltas) : tool.input, toolInput);
        } else {
          const tool = JSON.parse(result.body).content[0];
          assert.equal(tool.id, '789');
          assert.deepEqual(tool.input, toolInput);
        }
        const requestLogs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=20`);
        const log = requestLogs.json.items.find((item) => item.id === requestId);
        assert.ok(log);
        assert.ok(!log.diagnostics.warnings.some((message) => /\.input\./.test(message)), '不能把工具参数误报为协议 ID');
      }
    }
    console.log('output guard integration tests passed');
  } finally {
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
    if (stderr) console.error(stderr);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
