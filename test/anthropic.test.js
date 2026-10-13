const assert = require('node:assert/strict');
const { anthropicToOpenAI, openAIToAnthropic, openAIResponseToAnthropic } = require('../src/protocol');
const { createAnthropicStream } = require('../src/stream-conversion');

// Messages 客户端按 start -> delta* -> stop 消费每一个内容块，不能交错打开多个块。
function collectMessage(events) {
  let message;
  let active;
  let stopped = false;
  for (const { name, data } of events) {
    assert.equal(name, data.type);
    assert.equal(stopped, false, 'message_stop 后不能继续输出');
    if (name === 'message_start') {
      assert.equal(message, undefined);
      message = { ...data.message, content: [] };
    } else if (name === 'content_block_start') {
      assert.equal(active, undefined, '前一个内容块必须先结束');
      assert.equal(data.index, message.content.length);
      active = { index: data.index, json: '' };
      message.content.push({ ...data.content_block });
    } else if (name === 'content_block_delta') {
      assert.equal(data.index, active?.index, '增量必须属于当前内容块');
      if (data.delta.type === 'text_delta') message.content[data.index].text += data.delta.text;
      else if (data.delta.type === 'input_json_delta') active.json += data.delta.partial_json;
      else assert.fail(`意外的增量类型 ${data.delta.type}`);
    } else if (name === 'content_block_stop') {
      assert.equal(data.index, active?.index);
      if (active.json) message.content[data.index].input = JSON.parse(active.json);
      active = undefined;
    } else if (name === 'message_delta') {
      assert.equal(active, undefined);
      Object.assign(message, data.delta);
      Object.assign(message.usage, data.usage);
    } else if (name === 'message_stop') {
      assert.equal(active, undefined);
      stopped = true;
    } else assert.fail(`意外的 SSE 事件 ${name}`);
  }
  assert.equal(stopped, true);
  return message;
}

const events = [];
const stream = createAnthropicStream((data, name) => events.push({ data, name }), 'local-model');
stream.chunk({ choices: [{ delta: { content: '开始查询。' } }] });
assert.equal(events.at(-1).data.delta.text, '开始查询。', '文本不能等整个上游流结束才发送');
stream.chunk({ choices: [{ delta: { tool_calls: [
  { index: 0, id: 'call_one', function: { name: 'lookup', arguments: '{"id":' } },
  { index: 1, id: 'call_two', function: { name: 'lookup', arguments: '{"id":' } }
] } }] });
assert.ok(events.some(({ data }) => data.delta?.partial_json === '{"id":'), '第一个工具仍须增量输出');
stream.chunk({ choices: [{ delta: { tool_calls: [
  { index: 1, function: { arguments: '2}' } },
  { index: 0, function: { arguments: '1}' } }
] } }] });
stream.chunk({ choices: [{ delta: { content: '查询完毕。' }, finish_reason: 'tool_calls' }] });
stream.chunk({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } });
assert.deepEqual(stream.finish(), { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 });
const message = collectMessage(events);
assert.equal(message.model, 'local-model');
assert.equal(message.role, 'assistant');
assert.equal(message.stop_reason, 'tool_use');
assert.equal(message.stop_sequence, null);
assert.deepEqual(message.usage, { input_tokens: 123, output_tokens: 7 });
assert.deepEqual(message.content, [
  { type: 'text', text: '开始查询。' },
  { type: 'tool_use', id: 'call_one', name: 'lookup', input: { id: 1 } },
  { type: 'tool_use', id: 'call_two', name: 'lookup', input: { id: 2 } },
  { type: 'text', text: '查询完毕。' }
]);

for (const [reason, expected] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['tool_calls', 'tool_use'], ['content_filter', 'refusal']]) {
  const frames = [];
  const converter = createAnthropicStream((data, name) => frames.push({ data, name }), 'local-model');
  converter.chunk({ choices: [{ delta: { content: 'answer' }, finish_reason: reason }] });
  converter.finish();
  assert.equal(collectMessage(frames).stop_reason, expected);
  assert.equal(openAIResponseToAnthropic({ choices: [{ message: { content: 'answer' }, finish_reason: reason }] }, 'local-model').stop_reason, expected);
}
const emptyEvents = [];
createAnthropicStream((data, name) => emptyEvents.push({ data, name }), 'local-model').finish();
assert.deepEqual(collectMessage(emptyEvents).content, []);

const source = {
  system: [{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } }],
  max_tokens: 128,
  stream: true,
  tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { id: { type: 'number' } } } }],
  tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Look up an image.', cache_control: { type: 'ephemeral' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_one', name: 'lookup', input: { id: 1 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_one' }, { type: 'text', text: 'Continue.' }] }
  ]
};
const savedSource = JSON.stringify(source);
const converted = anthropicToOpenAI(source, 'upstream-model');
assert.equal(JSON.stringify(source), savedSource, '转换不能修改原始请求');
assert.equal(converted.model, 'upstream-model');
assert.deepEqual(converted.messages[0], { role: 'system', content: 'Be helpful.' });
assert.deepEqual(converted.messages[1].content, [
  { type: 'text', text: 'Look up an image.' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }
]);
assert.equal(converted.messages[2].tool_calls[0].function.arguments, '{"id":1}');
assert.deepEqual(converted.messages[3], { role: 'tool', tool_call_id: 'call_one', content: '' });
assert.deepEqual(converted.messages[4], { role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
assert.deepEqual(converted.tools[0].function.parameters, source.tools[0].input_schema);
assert.deepEqual(converted.tool_choice, { type: 'function', function: { name: 'lookup' } });
assert.equal(converted.parallel_tool_calls, false);
assert.deepEqual(converted.stream_options, { include_usage: true });
assert.equal(anthropicToOpenAI({ ...source, stream: false }, 'm').stream_options, undefined);
for (const disabled of [true, false]) {
  const chat = anthropicToOpenAI({ ...source, tool_choice: { type: 'auto', disable_parallel_tool_use: disabled } }, 'm');
  assert.equal(chat.parallel_tool_calls, !disabled);
  assert.deepEqual(openAIToAnthropic(chat, 'm').tool_choice, { type: 'auto', disable_parallel_tool_use: disabled });
}
assert.deepEqual(openAIToAnthropic({ messages: [], tools: converted.tools, parallel_tool_calls: false }, 'm').tool_choice,
  { type: 'auto', disable_parallel_tool_use: true });
assert.equal(anthropicToOpenAI({ messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'm').tools[0].type,
  'web_search_20250305', '原生服务端工具必须保留标记，不能伪装为可转换的 function');

const response = openAIResponseToAnthropic({
  id: 123,
  choices: [{ message: { content: null, tool_calls: [{ id: null, function: { name: 'lookup', arguments: '{"id":0,"metadata":{"id":null}}' } }] }, finish_reason: 'tool_calls' }]
}, 'local-model');
assert.equal(response.id, '123');
assert.equal(typeof response.content[0].id, 'string');
assert.ok(response.content[0].id.length > 0);
assert.deepEqual(response.content[0].input, { id: 0, metadata: { id: null } }, '不能改写工具业务数据里的 id');

console.log('Anthropic protocol and stream tests passed');