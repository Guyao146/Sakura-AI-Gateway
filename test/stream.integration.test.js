const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-stream-'));
const gatewayPort = 20000 + Math.floor(Math.random() * 1000);

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

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).filter(Boolean).map((frame) => {
    const event = { name: '', data: '' };
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event.name = line.slice(6).trim();
      if (line.startsWith('data:')) event.data += (event.data ? '\n' : '') + line.slice(5).trimStart();
    }
    return event;
  });
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function writeSplitStream(res, fixture) {
  const bytes = Buffer.from(fixture.text);
  if (fixture.singleChunk) return res.end(bytes);
  const unicodeIndex = bytes.indexOf(Buffer.from('错误'));
  const split = unicodeIndex >= 0 ? unicodeIndex + 1 : Math.max(1, Math.floor(bytes.length / 2));
  res.write(bytes.subarray(0, split));
  setTimeout(() => {
    if (fixture.disconnect) res.destroy();
    else res.end(bytes.subarray(split));
  }, 10);
}

async function main() {
  let openAIOverride = null;
  let anthropicOverride = null;
  const openAI = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url === '/v1/responses') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: { message: 'Responses API is not supported' } }));
    }
    if (req.url !== '/v1/chat/completions') return res.end('data: {"object":"list","data":[]}\n\n');
    const body = JSON.parse(raw);
    if (openAIOverride) return writeSplitStream(res, openAIOverride);
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'hello ' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: 'stream' }, finish_reason: null }] });
    writeSse(res, { id: 'stream-chat', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } });
    writeSse(res, '[DONE]');
    res.end();
  });
  const anthropic = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    res.setHeader('Content-Type', 'text/event-stream');
    if (req.url !== '/v1/messages') return res.end();
    const body = JSON.parse(raw);
    if (anthropicOverride) return writeSplitStream(res, anthropicOverride);
    writeSse(res, { type: 'message_start', message: { id: 'anthropic-stream', usage: { input_tokens: 7 } } }, 'message_start');
    writeSse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    writeSse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello anthropic' } }, 'content_block_delta');
    writeSse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
    writeSse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }, 'message_delta');
    writeSse(res, { type: 'message_stop' }, 'message_stop');
    // A real Anthropic stream ends with message_stop rather than [DONE].
    void body;
    res.end();
  });
  await new Promise((resolve) => openAI.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => anthropic.listen(0, '127.0.0.1', resolve));
  const openAIPort = openAI.address().port;
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
    const add = (name, port, protocol, model) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ name, baseUrl: `http://127.0.0.1:${port}/v1`, protocol, authType: 'none', apiKey: '', models: model })
    });
    const openAIUpstream = await add('openai-stream', openAIPort, 'openai', 'openai-stream-model');
    const anthropicUpstream = await add('anthropic-stream', anthropicPort, 'anthropic', 'anthropic-stream-model');
    assert.equal(openAIUpstream.status, 201, output);
    assert.equal(anthropicUpstream.status, 201, output);
    const addRoute = (localModel, upstreamId, upstreamModel) => requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ localModel, upstreamId, upstreamModel })
    });
    assert.equal((await addRoute('openai-stream-local', openAIUpstream.json.id, 'openai-stream-model')).status, 201);
    assert.equal((await addRoute('anthropic-stream-local', anthropicUpstream.json.id, 'anthropic-stream-model')).status, 201);
    const openAIStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-openai-001' }, body: JSON.stringify({ model: 'openai-stream-local', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(openAIStream.status, 200, openAIStream.body);
    assert.equal(openAIStream.headers['x-request-id'], 'stream-openai-001');
    const openAIEvents = parseSse(openAIStream.body);
    assert.equal(openAIEvents.filter((event) => event.data === '[DONE]').length, 1);
    assert.equal(openAIEvents.map((event) => event.data).filter((data) => data.includes('hello stream')).length, 0);
    const openAIJsonEvents = openAIEvents.map((event) => { try { return JSON.parse(event.data); } catch { return null; } }).filter(Boolean);
    assert.equal(new Set(openAIJsonEvents.map((event) => event.id)).size, 1);
    const openAIText = openAIJsonEvents.map((event) => event.choices?.[0]?.delta?.content || '').join('');
    assert.equal(openAIText, 'hello stream');
    const anthropicStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-anthropic-001' }, body: JSON.stringify({ model: 'anthropic-stream-local', stream: true, messages: [{ role: 'user', content: 'hi' }] })
    });
    assert.equal(anthropicStream.status, 200, anthropicStream.body);
    assert.equal(anthropicStream.headers['x-request-id'], 'stream-anthropic-001');
    const anthropicEvents = parseSse(anthropicStream.body);
    assert.equal(anthropicEvents.filter((event) => event.data === '[DONE]').length, 1);
    const anthropicJsonEvents = anthropicEvents.map((event) => { try { return JSON.parse(event.data); } catch { return null; } }).filter(Boolean);
    assert.equal(new Set(anthropicJsonEvents.map((event) => event.id)).size, 1);
    const anthropicText = anthropicJsonEvents.map((event) => event.choices?.[0]?.delta?.content || '').join('');
    assert.equal(anthropicText, 'hello anthropic');
    const responseStream = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'stream-responses-001' }, body: JSON.stringify({ model: 'openai-stream-local', stream: true, input: 'hi' })
    });
    assert.equal(responseStream.status, 200, responseStream.body);
    assert.equal(responseStream.headers['x-request-id'], 'stream-responses-001');
    const responseEvents = parseSse(responseStream.body);
    assert.ok(responseEvents.some((event) => event.name === 'response.created'));
    assert.ok(responseEvents.some((event) => event.name === 'response.output_text.delta'));
    assert.equal(responseEvents.filter((event) => event.name === 'response.completed').length, 1);
    const completed = JSON.parse(responseEvents.find((event) => event.name === 'response.completed').data);
    assert.equal(completed.response.output_text, 'hello stream');
    const metrics = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics`, { headers: adminHeaders });
    assert.equal(metrics.status, 200, JSON.stringify(metrics.json));
    assert.equal(metrics.json.totals.requests, 3);
    assert.equal(metrics.json.totals.promptTokens, 11);
    assert.equal(metrics.json.totals.completionTokens, 10);
    assert.equal(metrics.json.totals.totalTokens, 21);
    assert.equal(metrics.json.logs.every((entry) => entry.stream), true);
    // 正常透传必须逐字不变，包括中文跨网络分片、CRLF、注释和 [DONE]。
    const normalRaw = ': keepalive\r\n\r\ndata: not-json\r\n\r\ndata: {"id":"normal-stream","choices":[{"delta":{"content":"没有错误 😀"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
    openAIOverride = { text: normalRaw };
    const normal = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'openai-stream-local', stream: true, messages: [] })
    });
    openAIOverride = null;
    assert.equal(normal.status, 200);
    assert.equal(normal.body, normalRaw);

    // Chat 的末尾 usage-only 帧必须更新 Messages 客户端的输入 Token，而非永远为 0。
    const lateUsage = 'data: {"id":"late-usage","choices":[{"delta":{"content":"hello"}}]}\n\n'
      + 'data: {"id":"late-usage","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      + 'data: {"id":"late-usage","choices":[],"usage":{"prompt_tokens":123,"completion_tokens":7,"total_tokens":130}}\n\n'
      + 'data: [DONE]\n\n';
    openAIOverride = { text: lateUsage };
    const messagesUsage = await request(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'openai-stream-local', stream: true, messages: [], max_tokens: 32 })
    });
    openAIOverride = null;
    assert.equal(messagesUsage.status, 200, messagesUsage.body);
    const usageEvents = parseSse(messagesUsage.body).filter((event) => event.data).map((event) => JSON.parse(event.data));
    assert.equal(usageEvents[0].message.usage.input_tokens, 0);
    assert.deepEqual(usageEvents.find((event) => event.type === 'message_delta').usage, { input_tokens: 123, output_tokens: 7 });

    // Anthropic 的累计 input_tokens 也可能在 message_delta 更新，转换时不能只读 message_start。
    anthropicOverride = { text: 'event: message_start\ndata: {"type":"message_start","message":{"id":"late-anthropic","usage":{"input_tokens":0}}}\n\n'
      + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":123,"output_tokens":7}}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n' };
    const chatUsage = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify({ model: 'anthropic-stream-local', stream: true, messages: [] })
    });
    anthropicOverride = null;
    const usageChunk = parseSse(chatUsage.body).filter((event) => event.data && event.data !== '[DONE]').map((event) => JSON.parse(event.data)).find((chunk) => chunk.usage);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 });

    // 终止事件后的错误、用量和重复终止帧必须丢弃（包括同一网络分片内的尾随数据）。
    const trailingRequests = [];
    for (const upstreamProtocol of ['openai', 'anthropic']) {
      const successful = upstreamProtocol === 'openai'
        ? 'data: {"id":"terminal-chat","choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n'
        : 'event: message_start\ndata: {"type":"message_start","message":{"id":"terminal-message","usage":{"input_tokens":2}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
      const trailing = 'event: error\ndata: {"type":"error","error":{"message":"trailing-error","type":"overloaded_error"}}\n\n'
        + 'data: {"usage":{"prompt_tokens":999,"input_tokens":999}}\n\ndata: [DONE]\n\n';
      const fixture = { text: successful + trailing, singleChunk: true };
      if (upstreamProtocol === 'openai') openAIOverride = fixture;
      else anthropicOverride = fixture;
      const requestId = `terminal-${upstreamProtocol}`;
      trailingRequests.push(requestId);
      const result = await request(`http://127.0.0.1:${gatewayPort}/v1/${upstreamProtocol === 'openai' ? 'chat/completions' : 'messages'}`, {
        method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
        body: JSON.stringify({ model: `${upstreamProtocol}-stream-local`, stream: true, messages: [], max_tokens: 32 })
      });
      openAIOverride = null;
      anthropicOverride = null;
      assert.equal(result.status, 200, result.body);
      assert.equal(result.body, successful, '终止帧之前逐字保留，之后不再转发');
    }
    const terminalLogs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=100`, { headers: adminHeaders });
    for (const requestId of trailingRequests) {
      const entry = terminalLogs.json.items.find((item) => item.id === requestId);
      assert.ok(entry);
      assert.equal(entry.success, true, '已成功结束的请求不能被尾随错误污染');
      assert.equal(entry.usage.promptTokens, 2);
      assert.equal(entry.usage.completionTokens, 3);
    }

    const rawMessage = '上游流错误：请稍后重试';
    // 此套件只验证错误编码；冷却/熔断另有专用测试，避免连续错误摘除夹具上游。
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ circuitBreakerFailureThreshold: 20 })
    });
    for (const prefix of ['[TestGateway]', '']) {
      await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify({ errorPrefix: prefix })
      });
      for (const upstreamProtocol of ['openai', 'anthropic']) {
        const error = upstreamProtocol === 'openai'
          ? { type: 'rate_limit_error', code: 'stream_quota', message: rawMessage, param: 'model' }
          : { type: 'overloaded_error', message: rawMessage };
        const payload = { ...(upstreamProtocol === 'anthropic' ? { type: 'error' } : {}), error, request_id: 'upstream-only', extra: 'keep' };
        const fixture = {
          // 多行 data、保留 SSE 元信息，并故意不给末帧分隔符。
          text: `: upstream keepalive\r\n\r\nid: upstream-event\r\nretry: 1000\r\nevent: error\r\ndata: ${JSON.stringify(payload, null, 2).replace(/\n/g, '\r\ndata: ')}`
        };
        if (upstreamProtocol === 'openai') openAIOverride = fixture;
        else anthropicOverride = fixture;
        for (const [protocol, endpoint] of [['openai', '/v1/chat/completions'], ['anthropic', '/v1/messages'], ['responses', '/v1/responses']]) {
          const requestId = `stream-error-${upstreamProtocol}-${protocol}-${prefix ? 'prefix' : 'plain'}`;
          const result = await request(`http://127.0.0.1:${gatewayPort}${endpoint}`, {
            method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
            body: JSON.stringify({ model: `${upstreamProtocol}-stream-local`, stream: true,
              ...(protocol === 'responses' ? { input: 'error' } : { messages: [{ role: 'user', content: 'error' }], max_tokens: 32 }) })
          });
          assert.equal(result.status, 200, result.body);
          assert.equal(result.headers['x-request-id'], requestId);
          const events = parseSse(result.body).filter((event) => event.data && event.data !== '[DONE]');
          const errors = events.map((event) => ({ ...event, json: JSON.parse(event.data) }))
            .filter((event) => event.json.error || event.json.type === 'error');
          assert.equal(errors.length, 1, `流错误不能被吞掉或重复发送：${result.body}`);
          const event = errors[0];
          const details = event.json.error || event.json;
          assert.equal(event.json.request_id, requestId);
          assert.equal(details.message, `${prefix ? `${prefix} ` : ''}[request_id=${requestId}] [code=${error.code || '502'}] ${rawMessage}`);
          assert.equal(details.code, protocol === 'responses' ? (error.code || '502') : error.code);
          if (protocol !== 'responses') assert.equal(details.type, error.type);
          if (protocol !== 'openai') assert.equal(event.name, 'error');
          if (protocol === 'anthropic') assert.equal(event.json.type, 'error');
          if (protocol === upstreamProtocol) {
            assert.match(result.body, /: upstream keepalive\r\n\r\nid: upstream-event\r\nretry: 1000\r\nevent: error/);
            assert.equal(event.json.extra, 'keep');
          }
          assert.doesNotMatch(result.body, /response\.completed|message_stop|data: \[DONE\]/, '不能把失败伪装成成功结束');
          assert.match(result.body, /\r?\n\r?\n$/, '末尾错误帧必须有完整 SSE 分隔符');
        }
        openAIOverride = null;
        anthropicOverride = null;
      }
    }
    // 建立 200 流之后连接中断：三种客户端协议均返回 502 错误消息，而非 code=200。
    openAIOverride = { text: ': connection will close\n\n', disconnect: true };
    for (const [protocol, endpoint] of [['openai', '/v1/chat/completions'], ['anthropic', '/v1/messages'], ['responses', '/v1/responses']]) {
      const requestId = `stream-disconnect-${protocol}`;
      const result = await request(`http://127.0.0.1:${gatewayPort}${endpoint}`, {
        method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
        body: JSON.stringify({ model: 'openai-stream-local', stream: true,
          ...(protocol === 'responses' ? { input: 'disconnect' } : { messages: [{ role: 'user', content: 'disconnect' }], max_tokens: 32 }) })
      });
      assert.equal(result.status, 200);
      const events = parseSse(result.body).filter((event) => event.data && event.data !== '[DONE]');
      const errors = events.map((event) => JSON.parse(event.data)).filter((event) => event.error || event.type === 'error');
      assert.equal(errors.length, 1, result.body);
      assert.equal(errors[0].request_id, requestId);
      assert.ok((errors[0].error || errors[0]).message.startsWith(`[request_id=${requestId}] [code=502] `));
    }
    openAIOverride = null;
    const errorLogs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=100`, { headers: adminHeaders });
    for (const upstreamProtocol of ['openai', 'anthropic']) {
      for (const protocol of ['openai', 'anthropic', 'responses']) {
        const requestId = `stream-error-${upstreamProtocol}-${protocol}-plain`;
        const entry = errorLogs.json.items.find((item) => item.id === requestId);
        assert.ok(entry, `应根据错误消息中的 ${requestId} 查到日志`);
        assert.equal(entry.success, false, '上游 SSE 错误不能记作成功');
        assert.equal(entry.error, rawMessage, '原始错误保留在日志中');
        assert.deepEqual(entry.upstreamError, upstreamProtocol === 'openai'
          ? { status: 200, code: 'stream_quota', type: 'rate_limit_error', param: 'model', message: rawMessage }
          : { status: 200, type: 'overloaded_error', message: rawMessage }, '流式上游错误也要结构化记录');
      }
    }
    console.log('stream integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    openAI.closeAllConnections();
    anthropic.closeAllConnections();
    await Promise.all([
      new Promise((resolve) => openAI.close(resolve)),
      new Promise((resolve) => anthropic.close(resolve))
    ]);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});