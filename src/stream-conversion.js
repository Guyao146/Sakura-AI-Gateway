const crypto = require('node:crypto');
const { responsesResponseSkeleton, responseId, anthropicStopReason } = require('./protocol');

// 两个消费者共用 Chat 增量输入，避免 Messages/Responses 互转时再次丢失工具调用。
function createResponsesStream(write, model) {
  const id = `resp_${crypto.randomBytes(8).toString('hex')}`;
  const output = [];
  const tools = new Map();
  let message;
  let started = false;
  let finishReason;
  let sequence = 0;
  let usage = {};
  const emit = (type, data) => write({ type, sequence_number: sequence++, ...data }, type);
  const start = () => {
    if (started) return;
    started = true;
    emit('response.created', { response: responsesResponseSkeleton(id, model) });
  };
  const added = (item) => {
    const index = output.length;
    output.push(item);
    emit('response.output_item.added', { response_id: id, output_index: index, item: { ...item } });
    return index;
  };
  return {
    chunk(parsed) {
      start();
      if (parsed.usage) usage = { ...usage, ...parsed.usage };
      const choice = parsed.choices?.[0] || {};
      const delta = choice.delta || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      if (delta.content) {
        if (!message) {
          const item = { id: `msg_${crypto.randomBytes(8).toString('hex')}`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
          message = { item, index: added(item), text: '' };
          emit('response.content_part.added', { response_id: id, item_id: item.id, output_index: message.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        }
        message.text += delta.content;
        emit('response.output_text.delta', { response_id: id, item_id: message.item.id, output_index: message.index, content_index: 0, delta: delta.content });
      }
      for (const call of delta.tool_calls || []) {
        const key = call.index ?? 0;
        let tool = tools.get(key);
        if (!tool) {
          if (!call.function?.name) throw new Error('工具调用首帧缺少名称');
          const item = { type: 'function_call', id: `fc_${crypto.randomBytes(8).toString('hex')}`, call_id: responseId(call.id, `call_${crypto.randomBytes(8).toString('hex')}`), name: call.function?.name || '', arguments: '', status: 'in_progress' };
          tool = { item, index: added(item) };
          tools.set(key, tool);
        }
        if (call.function?.name) tool.item.name = call.function.name;
        if (call.function?.arguments) {
          tool.item.arguments += call.function.arguments;
          emit('response.function_call_arguments.delta', { response_id: id, item_id: tool.item.id, output_index: tool.index, delta: call.function.arguments });
        }
      }
    },
    finish() {
      start();
      const incomplete = finishReason === 'length' || finishReason === 'content_filter';
      for (const tool of tools.values()) {
        if (!tool.item.name) throw new Error('工具调用缺少名称');
        emit('response.function_call_arguments.done', { response_id: id, item_id: tool.item.id, output_index: tool.index, arguments: tool.item.arguments });
      }
      if (message) {
        const context = { response_id: id, item_id: message.item.id, output_index: message.index, content_index: 0 };
        const part = { type: 'output_text', text: message.text, annotations: [] };
        message.item.content = [part];
        emit('response.output_text.done', { ...context, text: message.text });
        emit('response.content_part.done', { ...context, part });
      }
      output.forEach((item, index) => {
        item.status = incomplete ? 'incomplete' : 'completed';
        emit('response.output_item.done', { response_id: id, output_index: index, item });
      });
      const type = incomplete ? 'response.incomplete' : 'response.completed';
      emit(type, { response: { ...responsesResponseSkeleton(id, model), status: incomplete ? 'incomplete' : 'completed', output,
        output_text: message?.text || '', ...(incomplete ? { incomplete_details: { reason: finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
        usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) } } });
      return usage;
    }
  };
}

function createAnthropicStream(write, model) {
  const id = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const blocks = [];
  const tools = new Map();
  let textBlock;
  let activeBlock;
  let started = false;
  let finishReason = 'stop';
  let usage = {};
  const emit = (type, data = {}) => write({ type, ...data }, type);
  const stopBlock = () => {
    if (!activeBlock) return;
    emit('content_block_stop', { index: activeBlock.index });
    activeBlock.stopped = true;
    activeBlock = undefined;
  };
  const startBlock = (item) => {
    activeBlock = item;
    emit('content_block_start', { index: item.index, content_block: item.content });
  };
  const block = (content_block) => {
    const item = { index: blocks.length, content: content_block, pending: [], stopped: false };
    blocks.push(item);
    if (activeBlock?.content.type === 'text') stopBlock();
    if (!activeBlock) startBlock(item);
    return item;
  };
  const delta = (item, value) => {
    if (item === activeBlock) emit('content_block_delta', { index: item.index, delta: value });
    else item.pending.push(value);
  };
  return {
    chunk(parsed) {
      if (parsed.usage) usage = { ...usage, ...parsed.usage };
      if (!started) {
        started = true;
        emit('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: 0 } } });
      }
      const choice = parsed.choices?.[0] || {};
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const change = choice.delta || {};
      if (change.content) {
        if (!textBlock) textBlock = block({ type: 'text', text: '' });
        delta(textBlock, { type: 'text_delta', text: change.content });
      }
      for (const call of change.tool_calls || []) {
        textBlock = undefined;
        const key = call.index ?? 0;
        if (!tools.has(key)) {
          if (!call.function?.name) throw new Error('工具调用首帧缺少名称');
          tools.set(key, block({ type: 'tool_use', id: responseId(call.id, `call_${crypto.randomBytes(8).toString('hex')}`), name: call.function.name, input: {} }));
        }
        if (call.function?.arguments) delta(tools.get(key), { type: 'input_json_delta', partial_json: call.function.arguments });
      }
    },
    finish() {
      if (!started) this.chunk({});
      stopBlock();
      // OpenAI 的并行工具增量可以交错；Messages 的块必须顺序结束。
      // 首个工具实时输出，其余工具/后续文本只缓存到上游正常结束，不重开已结束的块。
      for (const item of blocks) {
        if (item.stopped) continue;
        startBlock(item);
        for (const value of item.pending) delta(item, value);
        item.pending.length = 0;
        stopBlock();
      }
      // Chat/Responses 常到末帧才给输入用量；message_delta 允许补充累计 input_tokens，
      // 不需要为了等待用量而延迟 message_start 或缓存整段输出。
      emit('message_delta', { delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null }, usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 } });
      emit('message_stop');
      return usage;
    }
  };
}

module.exports = { createResponsesStream, createAnthropicStream };

