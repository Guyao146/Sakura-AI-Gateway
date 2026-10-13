const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-anthropic-'));
  const hits = [];
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const sse = (res, data, name = '') => res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  let handler = (req, res) => json(res, 500, { error: { message: 'Unexpected upstream request' } });
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    hits.push({ url: req.url, headers: req.headers, body });
    handler(req, res, body);
  });
  let gateway;
  let output = '';
  try {
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const reservation = http.createServer();
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const env = { ...process.env, SAKURA_AI_GATEWAY_DATA_DIR: directory, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port) };
    // 测试不能继承开发机的管理认证要求，更不能接触实际数据或上游。
    for (const name of Object.keys(env)) if (name.startsWith('AUTHENTIK_') || name.startsWith('ADMIN_')) delete env[name];
    gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', (chunk) => { output += chunk; });
    gateway.stderr.on('data', (chunk) => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);
      if (ready) break;
      assert.equal(gateway.exitCode, null, output);
      if (attempt === 199) assert.fail(`Gateway startup timed out: ${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const request = async (endpoint, body, headers = {}, method = 'POST') => {
      const response = await fetch(base + endpoint, { method, headers: { 'content-type': 'application/json', ...headers },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = raw; }
      return { status: response.status, headers: response.headers, body: payload };
    };
    const checked = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };
    const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'));
    const headers = { 'x-api-key': config.localApiKeys[0].key, 'anthropic-version': '2023-06-01' };
    const input = { model: 'chat-local', max_tokens: 128, messages: [{ role: 'user', content: '你好' }] };
    const messages = (body = input, auth = headers) => request('/v1/messages', body, auth);
    const assertError = (result, status, type) => {
      const body = checked(result, status);
      assert.equal(body.type, 'error');
      assert.equal(body.error.type, type);
      assert.equal(typeof body.error.message, 'string');
      assert.equal(body.request_id, result.headers.get('x-request-id'));
      assert.equal(body.request_id, result.headers.get('request-id'), 'Anthropic SDK 使用 request-id 响应头');
      return body;
    };
    // SDK 浏览器预检，不允许放宽管理 Cookie 的同源检查或透传客户端凭据到上游。
    const browserHeaders = ['content-type', 'x-api-key', 'anthropic-version', 'anthropic-beta',
      'anthropic-dangerous-direct-browser-access', 'x-request-id', 'x-stainless-lang', 'x-stainless-package-version',
      'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime', 'x-stainless-runtime-version',
      'x-stainless-retry-count', 'x-stainless-timeout', 'x-stainless-helper-method'];
    const preflight = await request('/v1/messages', undefined, { Origin: 'https://client.example',
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': browserHeaders.join(', ') }, 'OPTIONS');
    assert.equal(preflight.status, 204);
    const allowed = preflight.headers.get('access-control-allow-headers').toLowerCase().split(/,\s*/);
    for (const name of browserHeaders) assert.ok(allowed.includes(name), `CORS 没有放行 ${name}`);
    const exposed = preflight.headers.get('access-control-expose-headers').toLowerCase().split(/,\s*/);
    assert.ok(exposed.includes('request-id') && exposed.includes('x-request-id'));
    assertError(await messages(input, {}), 401, 'authentication_error');
    assertError(await messages('{'), 400, 'invalid_request_error');
    assertError(await messages({ ...input, model: '' }), 400, 'invalid_request_error');
    assertError(await messages(), 404, 'not_found_error');
    assertError(await request('/v1/messages/count_tokens', input, headers), 404, 'not_found_error');
    assertError(await request('/v1/messages', undefined, headers, 'GET'), 404, 'not_found_error');
    assert.equal(hits.length, 0);
    checked(await request('/api/admin/settings', { upstreamRetries: 0, requestsPerMinute: 0 }, {}, 'PUT'));
    const addUpstream = async (protocol, authType, apiKey) => checked(await request('/api/admin/upstreams', {
      name: protocol, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol, authType, apiKey, models: ['upstream-model']
    }), 201);
    const chat = await addUpstream('openai', 'bearer', 'openai-upstream-secret');
    const native = await addUpstream('anthropic', 'x-api-key', 'anthropic-upstream-secret');
    for (const [localModel, upstreamId, responsesMode] of [
      ['chat-local', chat.id, 'chat'], ['responses-local', chat.id, 'native'], ['native-local', native.id, 'auto']
    ]) checked(await request('/api/admin/routes', { localModel, upstreamId, upstreamModel: 'upstream-model', responsesMode }), 201);

    const tool = { name: 'lookup', description: 'Look up a value', input_schema: { type: 'object', properties: { id: { type: 'number' } } } };
    const conversation = { ...input, system: [{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }],
      tools: [tool], tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Look up the image.', cache_control: { type: 'ephemeral' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_one', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_one' }, { type: 'text', text: 'Continue.' }] }
      ] };
    const answer = { id: 'chat_answer', choices: [{ message: { role: 'assistant', content: '完成',
      tool_calls: [{ id: 'call_two', type: 'function', function: { name: 'lookup', arguments: '{"id":2}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } };
    handler = (req, res) => json(res, 200, answer);
    const converted = await messages(conversation, { ...headers, 'x-request-id': 'anthropic-json', 'anthropic-beta': 'tools-2024-04-04', Cookie: 'private-session=do-not-forward' });
    checked(converted);
    assert.equal(converted.headers.get('request-id'), 'anthropic-json');
    assert.equal(converted.body.request_id, 'anthropic-json');
    assert.equal(converted.body.model, 'chat-local');
    assert.equal(converted.body.type, 'message');
    assert.equal(converted.body.role, 'assistant');
    assert.equal(converted.body.stop_reason, 'tool_use');
    assert.equal(converted.body.stop_sequence, null);
    assert.deepEqual(converted.body.content, [{ type: 'text', text: '完成' }, { type: 'tool_use', id: 'call_two', name: 'lookup', input: { id: 2 } }]);
    assert.deepEqual(converted.body.usage, { input_tokens: 11, output_tokens: 7 });
    const hit = hits.at(-1);
    assert.equal(hit.url, '/v1/chat/completions');
    assert.equal(hit.headers.authorization, 'Bearer openai-upstream-secret');
    for (const name of ['x-api-key', 'anthropic-version', 'anthropic-beta', 'cookie']) assert.equal(hit.headers[name], undefined, name);
    assert.equal(hit.headers['x-request-id'], 'anthropic-json');
    assert.equal(hit.body.model, 'upstream-model');
    assert.deepEqual(hit.body.messages[0], { role: 'system', content: 'Be helpful.' });
    assert.deepEqual(hit.body.messages[1].content, [{ type: 'text', text: 'Look up the image.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }]);
    assert.equal(hit.body.messages[2].tool_calls[0].function.arguments, '{"id":1}');
    assert.deepEqual(hit.body.messages[3], { role: 'tool', tool_call_id: 'call_one', content: '' });
    assert.deepEqual(hit.body.tools[0].function.parameters, tool.input_schema);
    assert.equal(hit.body.parallel_tool_calls, false);
    assert.equal(hit.body.stream_options, undefined);
    checked(await messages(input, { Authorization: `Bearer ${config.localApiKeys[0].key}` }));

    const nativeInput = { ...conversation, model: 'native-local' };
    handler = (req, res) => json(res, 200, { id: 'msg_native', type: 'message', role: 'assistant', model: 'upstream-model',
      content: [{ type: 'text', text: '原生回复' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 3 } });
    const nativeResult = checked(await messages(nativeInput, { ...headers, 'anthropic-version': '2099-01-01', 'anthropic-beta': 'tools-2024-04-04',
      Authorization: 'Bearer client-credential', Cookie: 'private-session=do-not-forward' }));
    assert.equal(nativeResult.model, 'native-local');
    assert.equal(nativeResult.content[0].text, '原生回复');
    assert.equal(hits.at(-1).url, '/v1/messages');
    assert.deepEqual(hits.at(-1).body, { ...nativeInput, model: 'upstream-model' });
    assert.equal(hits.at(-1).headers['anthropic-version'], '2099-01-01', '显式版本不能被默认值覆盖');
    assert.equal(hits.at(-1).headers['anthropic-beta'], 'tools-2024-04-04');
    assert.equal(hits.at(-1).headers['x-api-key'], 'anthropic-upstream-secret');
    assert.equal(hits.at(-1).headers.authorization, undefined);
    assert.equal(hits.at(-1).headers.cookie, undefined);
    checked(await messages(nativeInput, { 'x-api-key': config.localApiKeys[0].key }));
    assert.equal(hits.at(-1).headers['anthropic-version'], '2023-06-01');

    handler = (req, res) => json(res, 200, { id: 'resp_answer', status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses 回复' }] },
      { type: 'function_call', id: 'fc_two', call_id: 'call_two', name: 'lookup', arguments: '{"id":2}' }
    ], usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 } });
    const fromResponses = checked(await messages({ ...conversation, model: 'responses-local' }));
    assert.equal(hits.at(-1).url, '/v1/responses');
    assert.equal(hits.at(-1).body.parallel_tool_calls, false);
    assert.equal(fromResponses.stop_reason, 'tool_use');
    assert.deepEqual(fromResponses.content[1], { type: 'tool_use', id: 'call_two', name: 'lookup', input: { id: 2 } });

    // 带查询参数的 SDK 请求同样匹配；末尾 usage-only 帧和工具 JSON 增量都不能丢失。
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: '流式回复' } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_two', function: { name: 'lookup', arguments: '{"id":' } }] } }] });
      sse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '2}' } }] }, finish_reason: 'tool_calls' }] });
      sse(res, { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } });
      sse(res, '[DONE]');
      res.end();
    };
    const streamed = await request('/v1/messages?beta=true', { ...input, stream: true, tools: [tool] }, { ...headers, 'x-request-id': 'anthropic-stream' });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get('content-type'), /text\/event-stream/);
    assert.equal(streamed.headers.get('request-id'), 'anthropic-stream');
    assert.deepEqual(hits.at(-1).body.stream_options, { include_usage: true });
    const frames = streamed.body.trim().split(/\r?\n\r?\n/).map((frame) => {
      const lines = frame.split(/\r?\n/);
      const data = JSON.parse(lines.find((line) => line.startsWith('data: ')).slice(6));
      assert.equal(lines.find((line) => line.startsWith('event: ')).slice(7), data.type);
      return data;
    });
    assert.deepEqual(frames.map((frame) => frame.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop',
      'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    assert.equal(frames[0].message.model, 'chat-local');
    assert.deepEqual(frames.at(-2).usage, { input_tokens: 11, output_tokens: 7 });
    assert.equal(frames.at(-2).delta.stop_reason, 'tool_use');
    assert.doesNotMatch(streamed.body, /\[DONE\]/);

    const beforeNativeTool = hits.length;
    const unsupported = await messages({ ...input, tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
    assertError(unsupported, 400, 'invalid_request_error');
    assert.equal(unsupported.body.error.code, 'unsupported_protocol_conversion');
    assert.equal(hits.length, beforeNativeTool, '不能把 Anthropic 服务端工具静默转换成自定义函数');
    for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'],
      [404, 'not_found_error'], [413, 'request_too_large'], [429, 'rate_limit_error'], [500, 'api_error'], [529, 'overloaded_error']]) {
      handler = (req, res) => json(res, status, { error: { type: 'vendor_error', code: 'vendor_code', message: 'upstream rejected' } });
      const error = assertError(await messages(), status, type);
      assert.equal(error.error.code, 'vendor_code');
      assert.equal(error.error.upstream_type, 'vendor_error');
      checked(await request(`/api/admin/upstreams/${chat.id}/reset-health`, {}));
    }
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { choices: [{ delta: { content: 'partial' } }] });
      sse(res, { error: { type: 'server_error', code: 'stream_failed', message: 'stream failed' } });
      res.end();
    };
    const failedStream = await messages({ ...input, stream: true });
    assert.equal(failedStream.status, 200);
    assert.match(failedStream.body, /event: error/);
    assert.match(failedStream.body, /"type":"api_error"/);
    assert.match(failedStream.body, /stream_failed/);
    assert.doesNotMatch(failedStream.body, /message_stop|\[DONE\]/);
    // 同协议直通仍保留标准帧，但错误也必须遵循同一 Anthropic 错误出口。
    handler = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { type: 'message_start', message: { id: 'msg_native_stream', type: 'message', role: 'assistant',
        model: 'upstream-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }, 'message_start');
      sse(res, { type: 'error', error: { type: 'server_error', code: 'native_failed', message: 'native stream failed' } }, 'error');
      res.end();
    };
    const failedNativeStream = await messages({ ...input, model: 'native-local', stream: true });
    assert.equal(failedNativeStream.status, 200);
    assert.match(failedNativeStream.body, /event: message_start/);
    assert.match(failedNativeStream.body, /event: error/);
    assert.match(failedNativeStream.body, /"type":"api_error"/);
    assert.match(failedNativeStream.body, /"upstream_type":"server_error"/);
    assert.doesNotMatch(failedNativeStream.body, /message_stop|\[DONE\]/);
    checked(await request(`/api/admin/upstreams/${chat.id}/reset-health`, {}));
    handler = (req, res) => json(res, 200, answer);
    checked(await request('/api/admin/settings', { requestsPerMinute: 1 }, {}, 'PUT'));
    checked(await messages());
    const limited = await messages();
    assertError(limited, 429, 'rate_limit_error');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    console.log('Anthropic Messages integration tests passed');
  } catch (error) {
    throw new Error(`${error.stack || error.message}\n${output.slice(-4000)}`);
  } finally {
    if (gateway && gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });