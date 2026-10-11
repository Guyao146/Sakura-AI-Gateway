const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-endpoints-'));
  const hits = [];
  let handler;
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const sse = (res, data, name = '') => res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    hits.push({ url: req.url, body, headers: req.headers });
    handler(req, res, body);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const reserve = http.createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
    cwd: root, env: { ...process.env, SAKURA_AI_GATEWAY_DATA_DIR: directory, SAKURA_AI_GATEWAY_FORCE_PORT: String(port), SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  async function api(url, body, method = 'POST', headers = {}) {
    const result = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const raw = await result.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = raw; }
    return { status: result.status, body: payload };
  }
  try {
    for (let count = 0; count < 100; count += 1) {
      if (output.includes('本地管理访问')) break;
      if (gateway.exitCode !== null) throw new Error(output);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    const headers = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const added = await api('/api/admin/upstreams', { name: 'multi', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: 'openai', authType: 'none', models: 'model' });
    assert.equal(added.status, 201, JSON.stringify(added));
    await api('/api/admin/routes', { localModel: 'local', upstreamId: added.body.id, upstreamModel: 'model' });
    const settings = (value) => api('/api/admin/settings', value, 'PUT');
    const reset = async () => { await api(`/api/admin/upstreams/${added.body.id}/reset-health`, {}); hits.length = 0; };
    const chat = (extra = {}) => api('/v1/chat/completions', { model: 'local', messages: [{ role: 'user', content: 'hi' }], ...extra }, 'POST', headers);
    const ok = (req, res) => json(res, 200, req.url === '/v1/responses'
      ? { id: 'resp_ok', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
      : { id: 'chat_ok', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    const incompatible = { error: { message: 'Function tools with reasoning_effort are not supported in /v1/chat/completions. Use /v1/responses instead.' } };
    await settings({ upstreamRetries: 2, circuitBreakerFailureThreshold: 3, circuitBreakerCooldownMs: 1000 });
    handler = (req, res) => req.url === '/v1/chat/completions' ? json(res, 400, incompatible) : ok(req, res);
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }];
    assert.equal((await chat({ tools, reasoning_effort: 'high' })).body.choices[0].message.content, 'ok');
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/chat/completions', '/v1/responses']);
    assert.deepEqual(hits[1].body.reasoning, { effort: 'none' });
    assert.equal(hits[1].body.reasoning_effort, undefined);
    hits.length = 0;
    await chat();
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/responses'], 'cooling Chat is skipped');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    hits.length = 0;
    handler = ok;
    await chat();
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/chat/completions'], 'preferred endpoint recovers');
    await reset();
    await settings({ upstreamRetries: 0, circuitBreakerFailureThreshold: 2 });
    handler = (req, res) => req.url === '/v1/chat/completions' ? json(res, 503, { error: { message: 'busy' } }) : ok(req, res);
    assert.equal((await chat()).status, 503);
    assert.equal((await chat()).status, 200, 'second failure cools Chat and switches within the same request');
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/chat/completions', '/v1/chat/completions', '/v1/responses']);
    await reset();
    for (const status of [400, 401, 403, 429]) {
      handler = (req, res) => json(res, status, { error: { message: 'rejected' } });
      assert.equal((await chat()).status, status);
      assert.equal(hits.length, 1, 'validation/auth/rate errors must not switch APIs');
      await reset();
    }
    handler = (req, res) => req.url === '/v1/chat/completions' ? json(res, 200, incompatible) : ok(req, res);
    assert.equal((await chat()).status, 200);
    assert.equal(hits.length, 2, 'HTTP 200 capability error must switch');
    await reset();
    handler = (req, res) => {
      if (req.url !== '/v1/messages') return json(res, 404, { error: { message: 'endpoint not found' } });
      json(res, 200, { id: 'msg', type: 'message', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { x: 1 } }], stop_reason: 'tool_use' });
    };
    const messagesFallback = await chat({ tools });
    assert.equal(messagesFallback.body.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/chat/completions', '/v1/responses', '/v1/messages']);
    assert.equal(hits.at(-1).headers['anthropic-version'], '2023-06-01');
    await reset();
    await settings({ upstreamRetries: 2, circuitBreakerFailureThreshold: 2 });
    handler = (req, res) => json(res, 404, { error: { message: 'endpoint not found' } });
    assert.equal((await chat()).status, 404);
    assert.equal(hits.length, 3, 'at most three endpoints, no loops');
    hits.length = 0;
    assert.equal((await chat()).status, 503);
    assert.equal(hits.length, 0, 'all cooling endpoints are skipped');
    await reset();
    await settings({ upstreamRetries: 0, circuitBreakerFailureThreshold: 2 });
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { id: 'partial', choices: [{ delta: { content: 'once' } }] });
      sse(res, incompatible);
      res.end();
    };
    const failedStream = await chat({ stream: true });
    assert.equal(failedStream.status, 200);
    assert.match(failedStream.body, /once/);
    assert.equal(hits.length, 1, 'never replay after stream output');
    assert.doesNotMatch(failedStream.body, /\[DONE\]/);
    handler = ok;
    hits.length = 0;
    await chat();
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/responses'], 'stream capability failure cools endpoint for next request');
    await reset();
    handler = (req, res) => {
      if (req.url === '/v1/responses') return json(res, 404, { error: { message: 'endpoint not found' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: 'text', tool_calls: [{ index: 0, id: 'call', function: { name: 'lookup', arguments: '{"x":' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] }, finish_reason: 'tool_calls' }] });
      sse(res, '[DONE]'); res.end();
    };
    const toolStream = await api('/v1/responses', { model: 'local', input: 'hi', stream: true, reasoning: { effort: 'high' } }, 'POST', headers);
    const events = toolStream.body.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
    assert.equal(events.at(-1).response.output[1].arguments, '{"x":1}');
    assert.equal(events.at(-1).response.output[1].call_id, 'call');
    assert.equal(hits[1].body.reasoning_effort, 'none');
    await reset();
    handler = (req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); sse(res, { choices: [{ delta: { content: 'truncated' } }] }); res.end(); };
    const truncated = await chat({ stream: true });
    assert.match(truncated.body, /upstream_error/);
    assert.doesNotMatch(truncated.body, /\[DONE\]/);
    assert.equal(hits.length, 1);
    await reset();
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (req.url === '/v1/chat/completions') sse(res, incompatible);
      else {
        sse(res, { type: 'response.output_text.delta', delta: 'recovered' }, 'response.output_text.delta');
        sse(res, { type: 'response.completed', response: { output: [] } }, 'response.completed');
      }
      res.end();
    };
    const firstFrameError = await chat({ stream: true });
    assert.match(firstFrameError.body, /recovered/);
    assert.doesNotMatch(firstFrameError.body, /Function tools/);
    assert.deepEqual(hits.map((hit) => hit.url), ['/v1/chat/completions', '/v1/responses']);
    await reset();
    await api('/api/admin/routes', { localModel: 'locked', upstreamId: added.body.id, upstreamModel: 'model', responsesMode: 'native' });
    handler = (req, res) => json(res, 404, { error: { message: 'endpoint not found' } });
    assert.equal((await chat({ model: 'locked' })).status, 404);
    assert.equal(hits.length, 1, 'explicit Responses lock cannot switch');
    await reset();
    handler = (req, res) => {
      if (req.url === '/v1/chat/completions') return json(res, 400, incompatible);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'call', name: 'lookup', arguments: '' } }, 'response.output_item.added');
      sse(res, { type: 'response.function_call_arguments.delta', item_id: 'fc', delta: '{}' }, 'response.function_call_arguments.delta');
      sse(res, { type: 'response.completed', response: { output: [] } }, 'response.completed');
      res.end();
    };
    const anthropic = await api('/v1/messages', { model: 'local', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, stream: true }, 'POST', headers);
    assert.match(anthropic.body, /"type":"tool_use"/);
    assert.match(anthropic.body, /"id":"call"/);
    assert.match(anthropic.body, /message_stop/);
    await reset();
    handler = (req, res) => {
      if (req.url !== '/v1/messages') return json(res, 404, { error: { message: 'endpoint not found' } });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { type: 'message_start', message: { usage: { input_tokens: 2 } } }, 'message_start');
      sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'initial' } }, 'content_block_start');
      sse(res, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'message-call', name: 'lookup', input: { x: 1 } } }, 'content_block_start');
      sse(res, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } }, 'message_delta');
      sse(res, { type: 'message_stop' }, 'message_stop');
      res.end();
    };
    const fromMessages = await api('/v1/responses', { model: 'local', input: 'hi', stream: true }, 'POST', headers);
    const messageOutput = fromMessages.body.split(/\r?\n/).filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6))).at(-1).response;
    assert.equal(messageOutput.output[0].content[0].text, 'initial');
    assert.equal(messageOutput.output[1].arguments, '{"x":1}');
    assert.equal(messageOutput.usage.total_tokens, 5);
    await reset();
    handler = ok;
    const native = await api('/v1/responses', { model: 'local', input: 'hi', thinkingLevel: 'off', thinking: { type: 'enabled', budget_tokens: 2048 }, reasoning_effort: 'high', reasoning: { effort: 'high' } }, 'POST', headers);
    assert.equal(native.status, 200);
    assert.deepEqual(hits[0].body.reasoning, { effort: 'none' });
    assert.equal(hits[0].body.reasoning_effort, undefined);
    assert.equal(hits[0].body.thinking, undefined);
    const metrics = await api('/api/admin/metrics', undefined, 'GET');
    assert.ok(metrics.body.logs.some((entry) => entry.attempts.some((attempt) => attempt.protocol === 'responses')));
    await reset();
    await settings({ upstreamTimeoutMs: 1000 });
    handler = (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); };
    assert.equal((await chat()).status, 502, 'timeout must include response body, not only headers');
    assert.equal(hits.length, 1);
    // 取消冷却后的恢复探测：分别覆盖收到响应头前、读取 JSON 正文期间。
    await settings({ upstreamTimeoutMs: 5000, upstreamRetries: 0, circuitBreakerCooldownMs: 1000 });
    for (const stage of ['headers', 'body']) {
      await reset();
      handler = (req, res) => json(res, 404, { error: { code: 'unsupported_endpoint', message: 'endpoint not found' } });
      assert.equal((await chat({ model: 'locked' })).status, 404);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      let held;
      handler = (req, res) => {
        held = res;
        if (stage === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders(); }
      };
      const controller = new AbortController();
      const requestId = `cancel-probe-${stage}`;
      const cancelled = fetch(base + '/v1/chat/completions', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ model: 'locked', messages: [] }), signal: controller.signal
      }).then((response) => response.text()).then(() => null, (error) => error);
      try {
        for (let index = 0; index < 100 && !held; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(held, '恢复探测必须已到达上游');
        controller.abort();
        assert.equal((await cancelled).name, 'AbortError');
        const cancellationLogged = () => output.split('\n').some((line) => line.includes('client cancelled') && line.includes(requestId));
        for (let index = 0; index < 100 && !cancellationLogged(); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(cancellationLogged(), '应等待网关完成取消清理');
        assert.equal(hits.length, 2, '取消后不能重试或切换接口');
        handler = ok;
        const recovered = await chat({ model: 'locked' });
        assert.equal(recovered.status, 200, '取消的探测不能让已恢复接口一直返回 endpoint_cooling_down');
        assert.equal(hits.length, 3);
        const logs = await api('/api/admin/metrics/logs?limit=100', undefined, 'GET');
        assert.ok(!logs.body.items.some((entry) => entry.id === requestId), '取消不是上游失败，不应写入失败统计');
      } finally {
        controller.abort();
        held?.destroy();
      }
    }
    console.log('endpoint routing integration tests passed');
  } catch (error) {
    throw new Error(`${error.stack}\n${output}`);
  } finally {
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

