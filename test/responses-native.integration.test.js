const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-responses-native-'));
const gatewayPort = 23000 + Math.floor(Math.random() * 1000);

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
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(`网关退出（${code}）：${output}`));
    });
  });
}

function writeSse(res, data, eventName) {
  if (eventName) res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSse(body) {
  return body.split(/\r?\n\r?\n/).map((frame) => {
    const name = frame.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim() || '';
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return data && data !== '[DONE]' ? { name, json: JSON.parse(data) } : null;
  }).filter(Boolean);
}

async function main() {
  const received = [];
  let rejectNativeResponses = false;
  let customFrames = null;
  let customJson = null;
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ url: req.url, body: raw ? JSON.parse(raw) : {}, headers: req.headers });
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'native-agent-model' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (!received.at(-1).body.stream) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ id: 'chat_test', choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_chat', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      writeSse(res, { id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_chat', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: null }] });
      writeSse(res, { id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url !== '/v1/responses') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'wrong endpoint' } }));
      return;
    }
    const body = received.at(-1).body;
    // 严格按 OpenAI Responses 规范校验：/v1/responses 只接受 reasoning: { effort }。
    // 如果还能在这里看到 Chat 协议的 reasoning_effort，说明网关没有按目标端点归一化参数。
    if (body.reasoning_effort !== undefined) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: '调用的接口类型和传入的参数不匹配：/v1/responses 不支持 reasoning_effort' } }));
      return;
    }
    // 模拟上游 schema 校验，禁止将 properties.id 等子 schema 改成字符串。
    for (const tool of body.tools || []) {
      if (tool.type !== 'function') continue;
      for (const schema of Object.values(tool.parameters?.properties || {})) {
        if (typeof schema === 'boolean' || (schema && typeof schema === 'object' && !Array.isArray(schema))) continue;
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_function_parameters',
          message: `Invalid schema for function '${tool.name}': '${schema}' is not of type 'object', 'boolean'` } }));
        return;
      }
    }
    res.setHeader('Content-Type', body.stream ? 'text/event-stream' : 'application/json');
    if (rejectNativeResponses) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { message: 'native responses unavailable' } }));
      return;
    }
    if (!body.stream && customJson) {
      res.statusCode = customJson.status;
      res.end(JSON.stringify(customJson.body));
      return;
    }
    if (body.stream && customFrames) {
      for (const frame of customFrames) writeSse(res, frame, frame.type);
      res.end();
      return;
    }
    if (!body.stream) {
      if (Array.isArray(body.tools) && body.tools.some((tool) => tool.type === 'function')) {
        res.end(JSON.stringify({
          id: 'resp_function_001',
          object: 'response',
          created_at: 1700000001,
          status: 'completed',
          model: body.model,
          output: [{ type: 'function_call', id: 'call_function_001', call_id: 'call_function_001', name: body.tools[0].name, arguments: '{"key":"weather"}' }],
          output_text: '',
          usage: { input_tokens: 11, output_tokens: 6, total_tokens: 17 }
        }));
        return;
      }
      res.end(JSON.stringify({
        id: 'resp_native_001',
        object: 'response',
        created_at: 1700000000,
        status: 'completed',
        model: body.model,
        output: [{
          id: 'call_native_001',
          type: 'computer_call',
          status: 'completed',
          action: { type: 'click', x: 12, y: 34 }
        }],
        output_text: '',
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        custom_agent_state: { preserved: true }
      }));
      return;
    }
    if (Array.isArray(body.tools) && body.tools.some((tool) => tool.type === 'function')) {
      // response.id 为数字；工具的 item.id 与 call_id 不同是正常的 Responses 形态。
      // 必须归一化 chunk ID，并把增量关联到同一 Chat 工具 index。
      writeSse(res, { type: 'response.created', response: { id: 12345, object: 'response', status: 'in_progress', model: body.model } }, 'response.created');
      writeSse(res, { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_function_stream', call_id: 'call_function_stream', name: body.tools[0].name, arguments: '' } }, 'response.output_item.added');
      writeSse(res, { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_function_stream', delta: '{"key":"weather"}' }, 'response.function_call_arguments.delta');
      writeSse(res, { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_function_stream', call_id: 'call_function_stream', name: body.tools[0].name, arguments: '{"key":"weather"}' } }, 'response.output_item.done');
      writeSse(res, { type: 'response.completed', response: { id: 12345, object: 'response', status: 'completed', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } }, 'response.completed');
      res.end();
      return;
    }
    writeSse(res, { type: 'response.created', response: { id: 'resp_native_stream', object: 'response', status: 'in_progress', model: body.model } }, 'response.created');
    writeSse(res, { type: 'response.output_item.added', item: { id: 'call_native_stream', type: 'computer_call', action: { type: 'screenshot' } } }, 'response.output_item.added');
    writeSse(res, { type: 'response.completed', response: { id: 'resp_native_stream', object: 'response', status: 'completed', output: [{ id: 'call_native_stream', type: 'computer_call', action: { type: 'screenshot' } }] } }, 'response.completed');
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
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const config = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const adminHeaders = {};
    const localHeaders = { Authorization: `Bearer ${config.localApiKeys[0].key}` };
    const added = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/upstreams`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ name: 'native-responses', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, protocol: 'openai', authType: 'none', models: 'native-agent-model', responsesMode: 'auto' })
    });
    assert.equal(added.status, 201, output);
    const route = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ localModel: 'agent-local', upstreamId: added.json.id, upstreamModel: 'native-agent-model' })
    });
    assert.equal(route.status, 201, JSON.stringify(route.json));
    const agentRequest = {
      model: 'agent-local',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Click the button' }] }],
      tools: [{ type: 'computer', display: { type: 'computer' } }],
      previous_response_id: 'resp_previous',
      include: ['computer_call.action'],
      custom_agent_state: { keep: true }
    };
    const response = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'native-agent-001', 'OpenAI-Beta': 'responses=v1' }, body: JSON.stringify(agentRequest)
    });
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.id, 'resp_native_001');
    assert.equal(response.json.output[0].type, 'computer_call');
    assert.deepEqual(response.json.output[0].action, { type: 'click', x: 12, y: 34 });
    assert.deepEqual(response.json.custom_agent_state, { preserved: true });
    const nativeCall = received.find((item) => item.url === '/v1/responses');
    assert.ok(nativeCall);
    assert.deepEqual(nativeCall.body.tools, agentRequest.tools);
    assert.equal(nativeCall.body.previous_response_id, 'resp_previous');
    assert.deepEqual(nativeCall.body.include, agentRequest.include);
    assert.deepEqual(nativeCall.body.custom_agent_state, agentRequest.custom_agent_state);
    assert.equal(nativeCall.body.model, 'native-agent-model');
    assert.equal(nativeCall.headers['openai-beta'], 'responses=v1');
    const functionReasoningRequest = {
      model: 'agent-local',
      input: 'Use the lookup function',
      tools: [{ type: 'function', name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
      reasoning_effort: 'medium'
    };
    const callsBeforeFunctionReasoning = received.length;
    const functionReasoningResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(functionReasoningRequest)
    });
    assert.equal(functionReasoningResponse.status, 200, JSON.stringify(functionReasoningResponse.json));
    const functionReasoningCalls = received.slice(callsBeforeFunctionReasoning);
    assert.equal(functionReasoningCalls.length, 1);
    assert.equal(functionReasoningCalls[0].url, '/v1/responses');
    assert.deepEqual(functionReasoningCalls[0].body.tools, functionReasoningRequest.tools);
    assert.equal(functionReasoningCalls[0].body.reasoning_effort, undefined);
    assert.deepEqual(functionReasoningCalls[0].body.reasoning, { effort: 'none' });
    const nativeRoute = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/routes`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ localModel: 'chat-native', upstreamId: added.json.id, upstreamModel: 'native-agent-model', responsesMode: 'native' })
    });
    assert.equal(nativeRoute.status, 201);
    // zcode/CronDelete 回归：三个客户端协议、JSON/SSE 都必须保留工具 schema。
    const cronSchema = {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Scheduled task ID' },
        tasks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, call_id: { type: 'string' } } } }
      },
      required: ['id'],
      additionalProperties: false
    };
    const cronTools = [
      ...Array.from({ length: 4 }, (_, index) => ({ type: 'function', name: `other_${index}`, parameters: { type: 'object', properties: {} } })),
      { type: 'function', name: 'CronDelete', parameters: cronSchema }
    ];
    const cronText = { format: { type: 'json_schema', name: 'task_result', schema: cronSchema } };
    const cronCall = { type: 'function_call', id: 601, call_id: 602, name: 'CronDelete', arguments: '{"id":"task-1"}' };
    const cronResponse = { id: 600, object: 'response', status: 'completed', tools: cronTools, text: cronText, output: [cronCall] };
    customJson = { status: 200, body: cronResponse };
    customFrames = [
      { type: 'response.created', response: { ...cronResponse, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...cronCall, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 601, delta: cronCall.arguments },
      { type: 'response.output_item.done', output_index: 0, item: cronCall },
      { type: 'response.completed', response: cronResponse }
    ];
    const cronMessages = [{ role: 'user', content: 'Delete the scheduled task' }];
    const cronRequests = [
      { endpoint: 'responses', body: { input: 'Delete the scheduled task', tools: cronTools, text: cronText, previous_response_id: null } },
      { endpoint: 'chat/completions', body: {
        messages: cronMessages,
        tools: cronTools.map(({ type, ...tool }) => ({ type, function: tool })),
        response_format: { type: 'json_schema', json_schema: { name: 'task_result', schema: cronSchema } }
      } },
      { endpoint: 'messages', body: {
        messages: cronMessages, max_tokens: 64,
        tools: cronTools.map((tool) => ({ name: tool.name, input_schema: tool.parameters }))
      } }
    ];
    for (const { endpoint, body } of cronRequests) {
      for (const stream of [false, true]) {
        const before = received.length;
        const result = await request(`http://127.0.0.1:${gatewayPort}/v1/${endpoint}`, {
          method: 'POST', headers: { ...localHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'chat-native', ...body, stream })
        });
        assert.equal(result.status, 200, `${endpoint}, stream=${stream}: ${result.body}`);
        const calls = received.slice(before);
        assert.equal(calls.length, 1, 'schema 合法时不应触发回退或重试');
        assert.equal(calls[0].url, '/v1/responses');
        assert.deepEqual(calls[0].body.tools, cronTools, `${endpoint} 转发的 schema 必须完整保留`);
        if (endpoint !== 'messages') assert.deepEqual(calls[0].body.text, cronText);
        assert.match(result.body, /CronDelete/);
        if (stream) {
          const events = parseSse(result.body);
          assert.ok(events.length > 0);
          assert.ok(events.every((event) => !event.json.error), result.body);
          if (endpoint === 'responses') {
            for (const type of ['response.created', 'response.completed']) {
              const event = events.find((item) => item.json.type === type);
              assert.ok(event, result.body);
              assert.deepEqual(event.json.response.tools, cronTools);
              assert.deepEqual(event.json.response.text, cronText);
              assert.equal(event.json.response.id, '600');
            }
            const completed = events.find((event) => event.json.type === 'response.completed').json.response;
            assert.equal(completed.output[0].id, '601');
            assert.equal(completed.output[0].call_id, '602');
          }
        } else {
          const json = JSON.parse(result.body);
          if (endpoint === 'responses') {
            assert.deepEqual(json.tools, cronTools);
            assert.deepEqual(json.text, cronText);
            assert.equal(json.id, '600');
            assert.equal(json.output[0].id, '601');
            assert.equal(json.output[0].call_id, '602');
          } else if (endpoint === 'chat/completions') {
            assert.equal(json.choices[0].message.tool_calls[0].id, '602');
          } else {
            assert.equal(json.content[0].id, '602');
          }
        }
      }
    }
    customJson = null;
    customFrames = null;
    const chatFunctionResponse = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        model: 'chat-native',
        messages: [{ role: 'user', content: 'Use the lookup function' }],
        tools: [{ type: 'function', function: { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } } }],
        reasoning_effort: 'medium'
      })
    });
    assert.equal(chatFunctionResponse.status, 200, JSON.stringify(chatFunctionResponse.json));
    assert.equal(chatFunctionResponse.json.choices[0].finish_reason, 'tool_calls');
    assert.equal(chatFunctionResponse.json.choices[0].message.tool_calls[0].function.name, 'lookup');
    const chatFunctionCall = received.at(-1);
    assert.equal(chatFunctionCall.url, '/v1/responses');
    assert.equal(chatFunctionCall.body.reasoning_effort, undefined);
    assert.deepEqual(chatFunctionCall.body.reasoning, { effort: 'none' });
    assert.equal(chatFunctionCall.body.tools[0].name, 'lookup');
    const chatFunctionStream = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({
        model: 'chat-native',
        stream: true,
        messages: [{ role: 'user', content: 'Use the lookup function' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
        reasoning_effort: 'medium'
      })
    });
    assert.equal(chatFunctionStream.status, 200, chatFunctionStream.body);
    assert.match(chatFunctionStream.body, /"tool_calls"/);
    assert.match(chatFunctionStream.body, /lookup/);
    assert.match(chatFunctionStream.body, /data: \[DONE\]/);
    // 回归护栏：上游返回数字 response.id 且 function_call 无 call_id 时，
    // 转回 Chat 流后每个 chunk.id 与工具调用首帧的 tool_call.id 都必须是字符串。
    const streamChunks = chatFunctionStream.body.split('\n\n')
      .filter((frame) => frame.startsWith('data:'))
      .map((frame) => frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
      .filter((data) => data && data !== '[DONE]')
      .map((data) => JSON.parse(data));
    assert.ok(streamChunks.length > 0, '应至少返回一个 chunk');
    const toolStates = new Map();
    for (const chunk of streamChunks) {
      assert.equal(typeof chunk.id, 'string', `chunk.id 必须是字符串，实际为 ${JSON.stringify(chunk.id)}`);
      for (const choice of chunk.choices || []) {
        for (const call of choice.delta?.tool_calls || []) {
          if (!toolStates.has(call.index)) {
            assert.equal(typeof call.id, 'string', '每个 index 首次出现必须有字符串 id');
            assert.equal(call.function.name, 'lookup');
            toolStates.set(call.index, { id: call.id, arguments: '' });
          }
          toolStates.get(call.index).arguments += call.function?.arguments || '';
        }
      }
    }
    assert.equal(toolStates.size, 1, '一个 Responses 调用不能拆成多个 Chat index');
    assert.deepEqual(toolStates.get(0), { id: 'call_function_stream', arguments: '{"key":"weather"}' });
    // 诊断信息应写入请求日志：能从后台 API 拿到该请求的上游路径与输出样本。
    const diagLogs = await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/metrics/logs?limit=50`, { headers: adminHeaders });
    assert.equal(diagLogs.status, 200, JSON.stringify(diagLogs.body));
    const diagEntry = (diagLogs.json.items || []).find((item) => item.stream && item.model === 'chat-native');
    assert.ok(diagEntry, '应能在请求日志中找到该流式请求');
    assert.ok(diagEntry.diagnostics, '该请求应携带诊断信息');
    assert.equal(diagEntry.diagnostics.upstreamPath, '/v1/responses');
    assert.equal(diagEntry.diagnostics.nativeResponses, true);
    assert.ok((diagEntry.diagnostics.upstreamResponse || []).length > 0, '应采样上游响应帧');
    assert.ok((diagEntry.diagnostics.output || []).length > 0, '应采样网关输出帧');
    // 多工具交错、output_index=0、缺失 call_id，以及参数先于 added 到达。
    const itemA = { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'lookup', arguments: '{"a":1}' };
    const itemB = { type: 'function_call', id: null, call_id: null, name: 'second', arguments: '{"b":2}' };
    customFrames = [
      { type: 'response.created', response: { id: 'resp_multi' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"a":' },
      { type: 'response.output_item.added', output_index: 1, item: { ...itemB, arguments: '' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...itemA, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, item_id: null, delta: '{"b":2}' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_a', delta: '1}' },
      { type: 'response.output_item.done', output_index: 0, item: itemA },
      { type: 'response.output_item.done', output_index: 1, item: itemB },
      { type: 'response.completed', response: { output: [itemA, itemB] } }
    ];
    const multi = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'chat-native', stream: true, messages: [{ role: 'user', content: 'tools' }] })
    });
    const nativeMulti = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'chat-native', stream: true, input: 'tools' })
    });
    const nativeEvents = parseSse(nativeMulti.body).map((event) => event.json);
    const nativeItems = nativeEvents.find((event) => event.type === 'response.completed').response.output;
    assert.notEqual(nativeItems[0].id, nativeItems[1].id);
    for (const event of nativeEvents) {
      if (event.type === 'response.function_call_arguments.delta') {
        assert.equal(event.item_id, nativeItems[event.output_index ?? 0].id, '原生流必须关联到同一个工具项');
      }
      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        assert.equal(event.item.id, nativeItems[event.output_index].id);
        assert.equal(event.item.call_id, nativeItems[event.output_index].call_id);
      }
    }
    customFrames.at(-1).response.usage = { input_tokens: 13, output_tokens: 7, total_tokens: 20 };
    customFrames.push({ type: 'error', error: { message: 'ignored-after-completed', type: 'server_error' } });
    const terminalNative = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'native-terminal-tail' },
      body: JSON.stringify({ model: 'chat-native', stream: true, input: 'tools' })
    });
    assert.doesNotMatch(terminalNative.body, /ignored-after-completed/);
    assert.equal(parseSse(terminalNative.body).at(-1).json.type, 'response.completed');
    const convertedUsage = await request(`http://127.0.0.1:${gatewayPort}/v1/messages`, {
      method: 'POST', headers: localHeaders,
      body: JSON.stringify({ model: 'chat-native', stream: true, messages: [], max_tokens: 32 })
    });
    assert.deepEqual(parseSse(convertedUsage.body).find((event) => event.name === 'message_delta').json.usage, { input_tokens: 13, output_tokens: 7 });
    customFrames = null;
    const assembled = new Map();
    for (const line of multi.body.split('\n').filter((line) => line.startsWith('data: {'))) {
      const chunk = JSON.parse(line.slice(6));
      assert.equal(chunk.error, undefined, multi.body);
      for (const call of chunk.choices?.[0]?.delta?.tool_calls || []) {
        if (!assembled.has(call.index)) {
          assert.equal(typeof call.id, 'string');
          assert.ok(call.id.length > 0);
          assert.equal(call.type, 'function');
          assembled.set(call.index, { name: call.function.name, arguments: '' });
        }
        assembled.get(call.index).arguments += call.function.arguments;
      }
    }
    assert.equal(assembled.size, 2);
    assert.deepEqual(assembled.get(0), { name: 'lookup', arguments: '{"a":1}' });
    assert.deepEqual(assembled.get(1), { name: 'second', arguments: '{"b":2}' });
    customFrames = [
      { type: 'response.function_call_arguments.delta', item_id: 'orphan', delta: '{}' },
      { type: 'response.completed', response: { output: [] } }
    ];
    const orphan = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'orphan-plain' },
      body: JSON.stringify({ model: 'chat-native', stream: true, messages: [{ role: 'user', content: 'tools' }] })
    });
    customFrames = null;
    assert.match(orphan.body, /无法转换为 Chat/);
    assert.doesNotMatch(orphan.body, /"tool_calls"/);
    const orphanErrors = parseSse(orphan.body).filter((event) => event.json.error);
    assert.equal(orphanErrors.length, 1);
    assert.equal(orphan.headers['x-request-id'], 'orphan-plain');
    assert.equal(orphanErrors[0].json.request_id, 'orphan-plain');
    assert.equal(orphanErrors[0].json.error.message, '[request_id=orphan-plain] [code=502] Responses 工具调用缺少名称或关联信息，无法转换为 Chat');
    // 工具调用转换失败属于网关自身错误，必须同样带上可自定义前缀。
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ errorPrefix: '[TestGateway]' })
    });
    customFrames = [
      { type: 'response.function_call_arguments.delta', item_id: 'orphan', delta: '{}' },
      { type: 'response.completed', response: { output: [] } }
    ];
    const prefixed = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'orphan-prefixed' },
      body: JSON.stringify({ model: 'chat-native', stream: true, messages: [{ role: 'user', content: 'tools' }] })
    });
    customFrames = null;
    const prefixedErrors = parseSse(prefixed.body).filter((event) => event.json.error);
    assert.equal(prefixedErrors.length, 1);
    assert.equal(prefixed.headers['x-request-id'], 'orphan-prefixed');
    assert.equal(prefixedErrors[0].json.request_id, 'orphan-prefixed');
    assert.equal(prefixedErrors[0].json.error.message, '[TestGateway] [request_id=orphan-prefixed] [code=502] Responses 工具调用缺少名称或关联信息，无法转换为 Chat');
    // 错误格式夹具独立于接口冷却测试，提升阈值避免连续错误相互干扰。
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ circuitBreakerFailureThreshold: 20 })
    });
    // 原生 Responses 的 error / response.failed 均保留原事件结构；转成 Chat 时也不能吞错。
    const nativeErrors = [
      { type: 'error', code: 'invalid_argument', message: '原生流错误', param: 'input', sequence_number: 2 },
      { type: 'error', error: { type: 'upstream_error', code: 0, message: '嵌套流错误' }, sequence_number: 3 },
      { type: 'response.failed', sequence_number: 4,
        response: { id: 'resp_failed_not_request', object: 'response', status: 'failed', output: [], error: { code: 'server_error', message: '响应失败错误' } } },
      { type: 'error', code: null, message: '缺少错误码', sequence_number: 5 }
    ];
    for (const prefix of ['[TestGateway]', '']) {
      await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
        method: 'PUT', headers: adminHeaders, body: JSON.stringify({ errorPrefix: prefix })
      });
      for (const [index, source] of nativeErrors.entries()) {
        for (const protocol of ['responses', 'chat']) {
          const requestId = `native-error-${protocol}-${index}-${prefix ? 'prefix' : 'plain'}`;
          customFrames = [
            { type: 'response.created', response: { id: source.response?.id || 'resp_before_error', status: 'in_progress' } },
            { ...source, request_id: 'upstream-only-request' }
          ];
          const result = await request(`http://127.0.0.1:${gatewayPort}/v1/${protocol === 'chat' ? 'chat/completions' : 'responses'}`, {
            method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
            body: JSON.stringify(protocol === 'chat'
              ? { model: 'chat-native', stream: true, messages: [{ role: 'user', content: 'error' }] }
              : { model: 'agent-local', stream: true, input: 'error' })
          });
          customFrames = null;
          assert.equal(result.status, 200, result.body);
          assert.equal(result.headers['x-request-id'], requestId);
          const events = parseSse(result.body);
          const errors = events.filter((event) => event.json.error || event.json.type === 'error' || event.json.type === 'response.failed');
          assert.equal(errors.length, 1, result.body);
          const event = errors[0];
          const original = source.error || source.response?.error || source;
          const details = event.json.error || event.json.response?.error || event.json;
          assert.equal(event.json.request_id, requestId);
          assert.equal(details.message, `${prefix ? `${prefix} ` : ''}[request_id=${requestId}] [code=${original.code ?? '502'}] ${original.message}`);
          assert.equal(details.code, original.code);
          if (protocol === 'responses') {
            assert.equal(event.name, source.type);
            assert.equal(event.json.type, source.type);
            assert.equal(event.json.sequence_number, source.sequence_number);
            if (source.response) {
              assert.equal(event.json.response.id, source.response.id);
              assert.equal(event.json.response.status, 'failed');
              assert.deepEqual(event.json.response.output, []);
            }
          }
          assert.doesNotMatch(result.body, /response\.completed|data: \[DONE\]/);
          assert.equal(received.at(-1).headers['x-request-id'], requestId);
        }
      }
    }
    // JSON 失败对象在 HTTP 200 内也要装饰，且不能经 Responses→Chat 变成成功回复。
    for (const status of [200, 429]) {
      customJson = { status, body: { id: 'resp_json_failure', object: 'response', status: 'failed', request_id: 'upstream-only-request',
        error: { code: 'json_failure', message: '原生 JSON 错误', type: 'rate_limit_error' }, output: [] } };
      for (const protocol of ['responses', 'chat']) {
        const requestId = `native-json-${status}-${protocol}`;
        const result = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/${protocol === 'chat' ? 'chat/completions' : 'responses'}`, {
          method: 'POST', headers: { ...localHeaders, 'x-request-id': requestId },
          body: JSON.stringify(protocol === 'chat'
            ? { model: 'chat-native', messages: [{ role: 'user', content: 'error' }] }
            : { model: 'agent-local', input: 'error' })
        });
        assert.equal(result.status, status === 200 ? 502 : status);
        assert.equal(result.headers['x-request-id'], requestId);
        assert.equal(result.json.request_id, requestId);
        assert.equal(result.json.error.code, 'json_failure');
        assert.equal(result.json.error.type, 'rate_limit_error');
        assert.equal(result.json.error.message, `[request_id=${requestId}] [code=json_failure] 原生 JSON 错误`);
        if (protocol === 'responses') assert.equal(result.json.id, 'resp_json_failure');
        assert.equal(result.json.choices, undefined);
      }
    }
    customJson = null;
    await requestJson(`http://127.0.0.1:${gatewayPort}/api/admin/settings`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ errorPrefix: '' })
    });
    // 自动模式下 Chat + tools 不应因思考开关改变端点。
    for (const thinkingLevel of ['medium', 'off']) {
      const before = received.length;
      const chat = await request(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST', headers: localHeaders,
        body: JSON.stringify({ model: 'agent-local', stream: true, thinkingLevel,
          messages: [{ role: 'user', content: 'lookup' }],
          tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] })
      });
      assert.equal(chat.status, 200, chat.body);
      assert.match(chat.body, /call_chat/);
      const calls = received.slice(before);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, '/v1/chat/completions');
      assert.equal(calls[0].body.reasoning_effort, thinkingLevel === 'off' ? undefined : 'medium');
      assert.equal(calls[0].body.reasoning, undefined);
    }
    const streamResponse = await request(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: { ...localHeaders, 'x-request-id': 'native-agent-stream-001' }, body: JSON.stringify({ ...agentRequest, stream: true })
    });
    assert.equal(streamResponse.status, 200, streamResponse.body);
    assert.match(streamResponse.body, /event: response\.output_item\.added/);
    assert.match(streamResponse.body, /"type":"computer_call"/);
    assert.match(streamResponse.body, /event: response\.completed/);
    assert.equal(streamResponse.headers['x-request-id'], 'native-agent-stream-001');
    // 反向归一化：客户端给 /v1/chat/completions 发 Responses 形态的 reasoning 对象时，应转成 Chat 的 reasoning_effort。
    const reasoningObjectCallsBefore = received.length;
    await requestJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: localHeaders,
      body: JSON.stringify({ model: 'agent-local', messages: [{ role: 'user', content: 'hello' }], reasoning: { effort: 'low' } })
    });
    const reasoningObjectCall = received.slice(reasoningObjectCallsBefore).find((item) => item.url === '/v1/chat/completions');
    assert.ok(reasoningObjectCall, '应命中 /v1/chat/completions');
    assert.equal(reasoningObjectCall.body.reasoning_effort, 'low');
    assert.equal(reasoningObjectCall.body.reasoning, undefined);
    rejectNativeResponses = true;
    // Responses 已强制 none，function tools 可以安全回退到 Chat。
    const callsBeforeUnsupportedFunctionReasoning = received.length;
    const unsupportedFunctionReasoning = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(functionReasoningRequest)
    });
    assert.equal(unsupportedFunctionReasoning.status, 200, JSON.stringify(unsupportedFunctionReasoning.json));
    assert.equal(unsupportedFunctionReasoning.json.output[0].type, 'function_call');
    const unsupportedFunctionReasoningCalls = received.slice(callsBeforeUnsupportedFunctionReasoning);
    assert.equal(unsupportedFunctionReasoningCalls.length, 2);
    assert.equal(unsupportedFunctionReasoningCalls[0].url, '/v1/responses');
    assert.equal(unsupportedFunctionReasoningCalls[1].body.reasoning_effort, 'none');
    const nativeOnlyCallsBefore = received.length;
    const unsupported = await requestJson(`http://127.0.0.1:${gatewayPort}/v1/responses`, {
      method: 'POST', headers: localHeaders, body: JSON.stringify(agentRequest)
    });
    assert.equal(unsupported.status, 503, JSON.stringify(unsupported.json));
    assert.equal(unsupported.json.error.code, 'endpoint_cooling_down');
    assert.equal(received.slice(nativeOnlyCallsBefore).length, 0, '原生能力不能降级，冷却期间也不能重新请求');
    console.log('native responses integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    if (gateway.exitCode === null && gateway.signalCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});