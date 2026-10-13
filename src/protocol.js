const crypto = require('node:crypto');

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveEndpoint(baseUrl, path) {
  const base = stripTrailingSlash(baseUrl);
  const target = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/v1') && target.startsWith('/v1/')) {
    return `${base}${target.slice(3)}`;
  }
  return `${base}${target}`;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || typeof part.text === 'string'))
    .map((part) => part.text || '')
    .join('');
}

function anthropicContentToOpenAI(content, role = 'assistant') {
  if (typeof content === 'string') return { content, tool_calls: undefined };
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text || '';
    if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id || `call_${crypto.randomBytes(5).toString('hex')}`,
        type: 'function',
        function: {
          name: block.name,
          arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input || {})
        }
      });
    }
  }
  const message = { role, content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { content: message.content, tool_calls: message.tool_calls };
}

function openAIContentToAnthropic(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (part.type === 'text' || typeof part.text === 'string') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      const url = part.image_url.url;
      const match = url.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
      }
      return { type: 'image', source: { type: 'url', url } };
    }
    return null;
  }).filter(Boolean);
}

function openAIToolsToAnthropic(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool && tool.type === 'function' && tool.function)
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters || { type: 'object', properties: {} }
    }));
}

function openAIToAnthropic(input, model) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const systemParts = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) => textFromContent(message.content))
    .filter(Boolean);
  const converted = [];

  for (const message of messages.filter((item) => item.role !== 'system' && item.role !== 'developer')) {
    if (message.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content: openAIContentToAnthropic(message.content)
        }]
      });
      continue;
    }

    const content = openAIContentToAnthropic(message.content);
    const blocks = Array.isArray(content) ? [...content] : (content ? [{ type: 'text', text: content }] : []);
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        let inputValue = {};
        try {
          inputValue = JSON.parse(call.function?.arguments || '{}');
        } catch {
          inputValue = { raw_arguments: call.function?.arguments || '' };
        }
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name,
          input: inputValue
        });
      }
    }
    converted.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: blocks.length ? blocks : [{ type: 'text', text: '' }]
    });
  }

  const messagesWithResults = [];
  for (const message of converted) {
    const previous = messagesWithResults.at(-1);
    if (previous?.role === 'user' && message.role === 'user') previous.content.push(...message.content);
    else messagesWithResults.push(message);
  }
  const result = {
    model,
    messages: messagesWithResults,
    max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (systemParts.length) result.system = systemParts.join('\n\n');
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.stop !== undefined) result.stop_sequences = Array.isArray(input.stop) ? input.stop : [input.stop];
  if (input.user !== undefined) result.metadata = { user_id: String(input.user) };
  if (input.thinking) {
    result.thinking = input.thinking;
  } else if (input.reasoning_effort !== undefined && String(input.reasoning_effort).trim().toLowerCase() !== 'none') {
    const effort = String(input.reasoning_effort).trim().toLowerCase();
    const budgets = { low: 2048, medium: 4096, high: 8192 };
    result.thinking = { type: 'enabled', budget_tokens: budgets[effort] || budgets.medium };
  }
  if (result.thinking?.type === 'enabled' && result.thinking.budget_tokens) {
    const minMaxTokens = Number(result.thinking.budget_tokens) + 1024;
    if (Number(result.max_tokens || 0) < minMaxTokens) {
      result.max_tokens = minMaxTokens;
    }
  }
  const tools = openAIToolsToAnthropic(input.tools);
  if (tools?.length) result.tools = tools;
  if (input.tool_choice) {
    if (input.tool_choice === 'auto' || input.tool_choice === 'none') {
      result.tool_choice = { type: input.tool_choice === 'auto' ? 'auto' : 'none' };
    } else if (input.tool_choice === 'required') {
      result.tool_choice = { type: 'any' };
    } else if (input.tool_choice.function?.name) {
      result.tool_choice = { type: 'tool', name: input.tool_choice.function.name };
    }
  }
  if (typeof input.parallel_tool_calls === 'boolean' && tools?.length && result.tool_choice?.type !== 'none') {
    result.tool_choice = { ...(result.tool_choice || { type: 'auto' }), disable_parallel_tool_use: !input.parallel_tool_calls };
  }
  return result;
}

function anthropicToOpenAI(input, model) {
  const result = {
    model,
    messages: [],
    max_tokens: input.max_tokens ?? input.max_completion_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (result.stream) result.stream_options = { include_usage: true };
  if (input.system) {
    result.messages.push({ role: 'system', content: textFromContent(input.system) });
  }
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (message.role === 'user' && Array.isArray(message.content)) {
      const toolResults = message.content.filter((block) => block.type === 'tool_result');
      for (const block of toolResults) {
        result.messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: anthropicInputContentToOpenAI(block.content ?? '')
        });
      }
      const normalBlocks = message.content.filter((block) => block.type !== 'tool_result');
      if (normalBlocks.length) {
        result.messages.push({ role: 'user', content: anthropicInputContentToOpenAI(normalBlocks) });
      }
      continue;
    }
    const converted = anthropicContentToOpenAI(message.content, message.role);
    result.messages.push({
      role: message.role,
      content: converted.content,
      ...(converted.tool_calls ? { tool_calls: converted.tool_calls } : {})
    });
  }
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.stop_sequences !== undefined) result.stop = input.stop_sequences;
  if (input.metadata?.user_id) result.user = String(input.metadata.user_id);
  if (input.reasoning_effort !== undefined) result.reasoning_effort = input.reasoning_effort;
  if (input.thinking?.type === 'enabled' && input.thinking.budget_tokens) {
    const budget = Number(input.thinking.budget_tokens);
    result.reasoning_effort = budget >= 8192 ? 'high' : budget >= 4096 ? 'medium' : 'low';
  }
  if (Array.isArray(input.tools)) {
    // 保留原生工具标记，由转发层拒绝有损跨协议转换；同协议仍原样转发。
    result.tools = input.tools.map((tool) => tool.type && tool.type !== 'custom' ? { ...tool } : ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || { type: 'object', properties: {} }
      }
    }));
  }
  if (input.tool_choice) {
    if (input.tool_choice === 'auto' || input.tool_choice?.type === 'auto') {
      result.tool_choice = 'auto';
    } else if (input.tool_choice === 'any' || input.tool_choice?.type === 'any') {
      result.tool_choice = 'required';
    } else if (input.tool_choice?.type === 'tool' && input.tool_choice.name) {
      result.tool_choice = { type: 'function', function: { name: input.tool_choice.name } };
    } else if (input.tool_choice?.type === 'none') {
      result.tool_choice = 'none';
    }
    if (typeof input.tool_choice.disable_parallel_tool_use === 'boolean') {
      result.parallel_tool_calls = !input.tool_choice.disable_parallel_tool_use;
    }
  }
  return result;
}

function anthropicInputContentToOpenAI(content) {
  if (!Array.isArray(content)) return content;
  return content.map((block) => {
    if (block.type === 'image' && block.source?.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` } };
    }
    if (block.type === 'image' && block.source?.type === 'url') {
      return { type: 'image_url', image_url: { url: block.source.url } };
    }
    // 未支持的非文本内容不能以错误的 Anthropic 形态直接传给 Chat；转发层会检测丢失并报错。
    return block.type === 'text' ? { type: 'text', text: block.text || '' } : null;
  }).filter(Boolean);
}

function anthropicStopReason(finishReason) {
  if (finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'content_filter') return 'refusal';
  return 'end_turn';
}

function openAIResponseToAnthropic(input, model) {
  const choice = input.choices?.[0] || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: textFromContent(message.content) });
  for (const call of message.tool_calls || []) {
    let parsedInput = {};
    try {
      parsedInput = JSON.parse(call.function?.arguments || '{}');
    } catch {
      parsedInput = { raw_arguments: call.function?.arguments || '' };
    }
    content.push({
      type: 'tool_use',
      id: responseId(call.id, `toolu_${crypto.randomBytes(8).toString('hex')}`),
      name: call.function?.name,
      input: parsedInput
    });
  }
  const finishReason = choice.finish_reason;
  return {
    id: responseId(input.id, `msg_${crypto.randomBytes(8).toString('hex')}`),
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: input.usage?.prompt_tokens || 0,
      output_tokens: input.usage?.completion_tokens || 0
    }
  };
}

function anthropicResponseToOpenAI(input, model) {
  const text = (input.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('');
  const toolCalls = (input.content || []).filter((part) => part.type === 'tool_use').map((part) => ({
    id: part.id,
    type: 'function',
    function: { name: part.name, arguments: JSON.stringify(part.input || {}) }
  }));
  return {
    id: input.id || `chatcmpl_${crypto.randomBytes(8).toString('hex')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: input.stop_reason === 'tool_use' ? 'tool_calls' : (input.stop_reason === 'max_tokens' ? 'length' : 'stop')
    }],
    usage: {
      prompt_tokens: input.usage?.input_tokens || 0,
      completion_tokens: input.usage?.output_tokens || 0,
      total_tokens: (input.usage?.input_tokens || 0) + (input.usage?.output_tokens || 0)
    }
  };
}

function responsesContentToOpenAI(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      return { type: 'text', text: part.text || '' };
    }
    if (part.type === 'input_image' && (part.image_url || part.image?.url)) {
      return { type: 'image_url', image_url: { url: part.image_url || part.image.url } };
    }
    return null;
  }).filter(Boolean);
}

function responsesToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((tool) => tool && tool.type === 'function').map((tool) => ({
    type: 'function',
    function: {
      name: tool.name || tool.function?.name,
      description: tool.description || tool.function?.description,
      parameters: tool.parameters || tool.input_schema || tool.function?.parameters || { type: 'object', properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {})
    }
  }));
}

function openAIContentToResponses(content, role) {
  const outputType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return [{ type: outputType, text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      return { type: outputType, text: part.text || '' };
    }
    if (part.type === 'image_url' && part.image_url?.url) {
      return { type: 'input_image', image_url: part.image_url.url };
    }
    return null;
  }).filter(Boolean);
}

function openAIToolsToResponses(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools.filter((tool) => tool && tool.type === 'function' && tool.function).map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters || { type: 'object', properties: {} },
    ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
    ...(tool.strict !== undefined ? { strict: tool.strict } : {})
  }));
}

function openAIRequestToResponses(input, model) {
  const result = {
    model,
    input: [],
    max_output_tokens: input.max_output_tokens ?? input.max_completion_tokens ?? input.max_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  for (const message of Array.isArray(input.messages) ? input.messages : []) {
    if (!message || typeof message !== 'object') continue;
    if (message.role === 'tool') {
      result.input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textFromContent(message.content)
      });
      continue;
    }
    if (Array.isArray(message.tool_calls)) {
      const messageContent = openAIContentToResponses(message.content, 'assistant');
      if (messageContent.length) result.input.push({ type: 'message', role: 'assistant', content: messageContent });
      for (const call of message.tool_calls) {
        if (!call?.function) continue;
        result.input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {})
        });
      }
      continue;
    }
    const content = openAIContentToResponses(message.content, message.role);
    result.input.push({
      type: 'message',
      role: message.role || 'user',
      content: content.length ? content : [{ type: 'input_text', text: '' }],
      ...(message.name ? { name: message.name } : {})
    });
  }
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  result.reasoning = { effort: 'none' };
  if (input.response_format?.type === 'json_schema') {
    result.text = { format: { type: 'json_schema', ...input.response_format.json_schema } };
  } else if (input.response_format) {
    result.text = { format: input.response_format };
  }
  if (input.tools) result.tools = openAIToolsToResponses(input.tools);
  if (input.tool_choice !== undefined) {
    if (typeof input.tool_choice === 'object' && input.tool_choice?.function?.name) {
      result.tool_choice = { type: 'function', name: input.tool_choice.function.name };
    } else {
      result.tool_choice = input.tool_choice;
    }
  }
  if (input.parallel_tool_calls !== undefined) result.parallel_tool_calls = input.parallel_tool_calls;
  if (input.user !== undefined) result.user = input.user;
  return result;
}

const RESPONSES_CHAT_FALLBACK_KEYS = new Set([
  'model', 'instructions', 'input', 'max_output_tokens', 'max_tokens', 'stream',
  'temperature', 'top_p', 'reasoning_effort', 'reasoning', 'thinking', 'tools', 'tool_choice', 'parallel_tool_calls',
  'stop', 'presence_penalty', 'frequency_penalty', 'user', 'seed', 'metadata', 'response_format', 'text'
]);
const RESPONSES_CHAT_INPUT_TYPES = new Set(['message', 'function_call', 'function_call_output']);
const RESPONSES_CHAT_CONTENT_TYPES = new Set(['input_text', 'output_text', 'text', 'input_image']);

function responseRequestRequiresNative(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return true;
  if (Object.keys(input).some((key) => !RESPONSES_CHAT_FALLBACK_KEYS.has(key))) return true;
  if (input.text && (Object.keys(input.text).some((key) => key !== 'format')
    || !['text', 'json_object', 'json_schema'].includes(input.text.format?.type))) return true;
  if (Array.isArray(input.tools) && input.tools.some((tool) => tool && tool.type !== 'function')) return true;
  // Responses 出站固定 none，function tools 不再因为原始思考强度禁止兼容转换。
  if (input.tool_choice && typeof input.tool_choice === 'object') {
    if (input.tool_choice.type && input.tool_choice.type !== 'function') return true;
    if (!input.tool_choice.name && !input.tool_choice.function?.name) return true;
  }
  const items = Array.isArray(input.input) ? input.input : [input.input];
  return items.some((item) => {
    if (item === undefined || item === null || typeof item === 'string') return false;
    if (typeof item !== 'object' || Array.isArray(item)) return true;
    if (item.type && !RESPONSES_CHAT_INPUT_TYPES.has(item.type)) return true;
    if (item.type === 'function_call_output' && typeof item.output !== 'string') return true;
    const content = item.content;
    return Array.isArray(content) && content.some((part) => part?.type && !RESPONSES_CHAT_CONTENT_TYPES.has(part.type));
  });
}

function chatRequestRequiresNative(input) {
  // Chat 的 function tools 与 reasoning_effort 可以同时使用；不能据此升级协议。
  // 是否使用 Responses 由显式的接口协议配置决定。
  return false;
}

function responseInputToOpenAI(input, model) {
  const result = {
    model,
    messages: [],
    max_tokens: input.max_output_tokens ?? input.max_tokens ?? 4096,
    stream: Boolean(input.stream)
  };
  if (input.instructions) result.messages.push({ role: 'system', content: textFromContent(input.instructions) });

  const items = Array.isArray(input.input)
    ? input.input
    : [input.input && typeof input.input === 'object'
      ? input.input
      : { role: 'user', content: input.input ?? '' }];
  for (const item of items) {
    if (typeof item === 'string') {
      result.messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call_output') {
      result.messages.push({
        role: 'tool',
        tool_call_id: responseId(item.call_id ?? item.id, `call_${crypto.randomBytes(8).toString('hex')}`),
        content: textFromContent(item.output)
      });
      continue;
    }
    if (item.type === 'function_call') {
      let argumentsValue = item.arguments || '{}';
      if (typeof argumentsValue !== 'string') argumentsValue = JSON.stringify(argumentsValue);
      const callId = responseId(item.call_id ?? item.id, `call_${crypto.randomBytes(8).toString('hex')}`);
      const call = { id: callId, type: 'function', function: { name: item.name, arguments: argumentsValue } };
      const previous = result.messages.at(-1);
      if (previous?.role === 'assistant' && previous.tool_calls) previous.tool_calls.push(call);
      else result.messages.push({ role: 'assistant', content: null, tool_calls: [call] });
      continue;
    }
    const role = item.role || (item.type === 'message' ? 'user' : 'user');
    const content = item.content === undefined ? item.text : responsesContentToOpenAI(item.content);
    result.messages.push({ role, content: content === undefined ? '' : content });
  }
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.top_p !== undefined) result.top_p = input.top_p;
  if (input.reasoning_effort !== undefined) {
    result.reasoning_effort = input.reasoning_effort;
  } else if (input.reasoning?.effort !== undefined) {
    result.reasoning_effort = input.reasoning.effort;
  }
  if (input.thinking !== undefined) result.thinking = input.thinking;
  if (input.tools) result.tools = responsesToolsToOpenAI(input.tools);
  if (input.tool_choice !== undefined) {
    if (typeof input.tool_choice === 'object' && input.tool_choice?.name) {
      result.tool_choice = { type: 'function', function: { name: input.tool_choice.name } };
    } else {
      result.tool_choice = input.tool_choice;
    }
  }
  if (input.parallel_tool_calls !== undefined) result.parallel_tool_calls = input.parallel_tool_calls;
  if (input.stop !== undefined) result.stop = input.stop;
  if (input.presence_penalty !== undefined) result.presence_penalty = input.presence_penalty;
  if (input.frequency_penalty !== undefined) result.frequency_penalty = input.frequency_penalty;
  if (input.user !== undefined) result.user = input.user;
  if (input.seed !== undefined) result.seed = input.seed;
  if (input.response_format !== undefined) result.response_format = input.response_format;
  if (input.text?.format) {
    const { type, ...schema } = input.text.format;
    result.response_format = type === 'json_schema' ? { type, json_schema: schema } : { type };
  }
  return result;
}

function openAIResponseToResponses(input, model) {
  const choice = input.choices?.[0] || {};
  const message = choice.message || {};
  const output = [];
  const messageId = `msg_${crypto.randomBytes(8).toString('hex')}`;
  const content = [];
  if (message.content) {
    content.push({ type: 'output_text', text: textFromContent(message.content), annotations: [] });
  }
  if (content.length) output.push({ id: messageId, type: 'message', status: 'completed', role: 'assistant', content });
  for (const call of message.tool_calls || []) {
    // 上游偶尔返回 null/数字/对象形式的 tool call id；Responses 客户端严格要求字符串，
    // 缺失时统一回填确定性 id，避免 “Expected 'id' to be a string”。
    const callId = responseId(call.id, `call_${crypto.randomBytes(8).toString('hex')}`);
    output.push({
      type: 'function_call',
      id: callId,
      call_id: callId,
      name: call.function?.name,
      arguments: call.function?.arguments || ''
    });
  }
  const text = content.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
  const usage = {
    input_tokens: input.usage?.prompt_tokens || 0,
    output_tokens: input.usage?.completion_tokens || 0,
    total_tokens: input.usage?.total_tokens || (input.usage?.prompt_tokens || 0) + (input.usage?.completion_tokens || 0)
  };
  return {
    // input.id 可能是 null/数字/对象（部分 OpenAI 兼容站点），先归一为字符串再拼接，
    // 否则 input.id.replace 会直接抛出 TypeError 并让整个请求以 500 失败。
    id: (() => {
      const normalized = responseId(input.id, '');
      return normalized ? `resp_${normalized.replace(/^(resp_)+/, '')}` : `resp_${crypto.randomBytes(8).toString('hex')}`;
    })(),
    object: 'response',
    created_at: input.created || Math.floor(Date.now() / 1000),
    status: choice.finish_reason === 'length' || choice.finish_reason === 'content_filter' ? 'incomplete' : 'completed',
    ...(choice.finish_reason === 'length' || choice.finish_reason === 'content_filter'
      ? { incomplete_details: { reason: choice.finish_reason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}),
    model,
    output,
    output_text: text,
    usage
  };
}

function responsesResponseToOpenAI(input, model) {
  const output = Array.isArray(input?.output) ? input.output : [];
  const text = [];
  const toolCalls = [];
  for (const item of output) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' || part?.type === 'text') text.push(part.text || '');
      }
    }
    if (item?.type === 'function_call') {
      toolCalls.push({
        id: responseId(item.call_id ?? item.id, `call_${crypto.randomBytes(8).toString('hex')}`),
        type: 'function',
        function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) }
      });
    }
  }
  const inputTokens = input?.usage?.input_tokens || 0;
  const outputTokens = input?.usage?.output_tokens || 0;
  // 截断状态优先于工具调用：参数被 max_output_tokens 切断时，工具调用不可执行，
  // 标成 tool_calls 会让客户端拿到半截 JSON 参数去执行。
  const incompleteReason = input?.status === 'incomplete' ? (input?.incomplete_details?.reason || 'max_output_tokens') : null;
  const finishReason = incompleteReason === 'content_filter' ? 'content_filter'
    : incompleteReason ? 'length'
    : (toolCalls.length ? 'tool_calls' : 'stop');
  return {
    id: responseId(input?.id, `chatcmpl_${crypto.randomBytes(8).toString('hex')}`),
    object: 'chat.completion',
    created: input?.created_at || Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: text.join('') || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: input?.usage?.total_tokens || inputTokens + outputTokens
    }
  };
}

function responsesResponseFromOpenAI(input, model) {
  return openAIResponseToResponses(input, model);
}

function responseId(value, fallback) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== undefined && value !== null && typeof value !== 'object') return String(value);
  return fallback;
}

// 一个输出项可能先收到参数增量，再收到 added。按 output_index 缓存已经发出的 ID，
// 上游 ID 别名单独保存，避免数字 ID 与 output_index 冲突；后续事件不能另造一个 ID。
function responsesItemId(value, outputIndex, state, alias) {
  const rawId = responseId(value, '');
  const aliasId = responseId(alias, '');
  const indexKey = outputIndex === undefined || outputIndex === null ? undefined : String(outputIndex);
  const cached = indexKey === undefined ? undefined : state?.itemIds?.[indexKey];
  const itemId = cached || state?.itemAliases?.get(rawId) || state?.itemAliases?.get(aliasId)
    || rawId || aliasId || `item_${indexKey ?? 'unknown'}_${crypto.randomBytes(6).toString('hex')}`;
  if (state) {
    state.itemAliases = state.itemAliases || new Map();
    for (const id of [rawId, aliasId, itemId]) if (id) state.itemAliases.set(id, itemId);
    if (indexKey !== undefined) {
      state.itemIds = state.itemIds || Object.create(null);
      state.itemIds[indexKey] = itemId;
    }
  }
  return itemId;
}

function normalizeResponsesItem(item, outputIndex, state, alias) {
  if (!item || typeof item !== 'object') return item;
  const id = responsesItemId(item.id, outputIndex, state, alias);
  const result = { ...item, id };
  if (item.call_id !== undefined || item.type === 'function_call') {
    result.call_id = state?.itemCallIds?.get(id) || responseId(item.call_id, id);
    if (state) {
      state.itemCallIds = state.itemCallIds || new Map();
      state.itemCallIds.set(id, result.call_id);
    }
  }
  return result;
}

function normalizeResponsesResponse(input, model, state) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { ...source, model: model || source.model };
  result.id = responseId(source.id, state?.responseId || `resp_${crypto.randomBytes(8).toString('hex')}`);
  if (Array.isArray(source.output)) {
    result.output = source.output.map((item, index) => normalizeResponsesItem(item, index, state));
  }
  return normalizeResponsesIds(result, state);
}

// 工具参数与结构化输出中的 JSON Schema 是不透明数据；其 properties/$defs/examples
// 可以合法包含 id/call_id 等同名字段，不能按协议 ID 递归改写（包括布尔 schema）。
function isJsonSchemaField(key) {
  return ['parameters', 'input_schema', 'schema', 'json_schema'].includes(key);
}

// 除 schema 外，工具参数/结果及 metadata 也是不透明业务数据。按父节点区分，
// 不能直接跳过所有 input/output：Responses 根对象的这两个字段仍包含协议 ID。
function isOpaqueIdField(parent, key) {
  if (isJsonSchemaField(key) || key === 'arguments' || key === 'metadata') return true;
  if (key === 'input') return ['tool_use', 'server_tool_use', 'custom_tool_call'].includes(parent.type);
  if (key === 'output') return ['function_call_output', 'custom_tool_call_output'].includes(parent.type);
  return key === 'content' && parent.type === 'tool_result';
}

function normalizeResponsesIds(value, state = {}, path = 'responses') {
  if (Array.isArray(value)) return value.map((item, index) => normalizeResponsesIds(item, state, `${path}.${index}`));
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isOpaqueIdField(value, key)) {
      result[key] = item;
    } else if (key === 'previous_response_id' && item === null) {
      result[key] = null;
    } else if (['id', 'call_id', 'item_id', 'response_id', 'previous_response_id'].includes(key)) {
      result[key] = responseId(item, `${key}_${crypto.createHash('sha256').update(`${path}.${key}`).digest('hex').slice(0, 16)}`);
    } else {
      result[key] = normalizeResponsesIds(item, state, `${path}.${key}`);
    }
  }
  return result;
}

function normalizeResponsesEvent(input, state = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const result = { ...source };
  if (source.type === 'response.created' && source.response && typeof source.response === 'object') {
    state.responseId = responseId(source.response.id, state.responseId || `resp_${crypto.randomBytes(8).toString('hex')}`);
    result.response = { ...source.response, id: state.responseId };
  } else if (source.response && typeof source.response === 'object' && source.response.id !== undefined) {
    result.response = { ...source.response, id: responseId(source.response.id, state.responseId || `resp_${crypto.randomBytes(8).toString('hex')}`) };
    state.responseId = result.response.id;
  }
  if (source.response_id !== undefined) result.response_id = responseId(source.response_id, state.responseId || `resp_${crypto.randomBytes(8).toString('hex')}`);
  if (result.response_id) state.responseId = result.response_id;

  if (source.item && typeof source.item === 'object') {
    const index = source.output_index ?? (responseId(source.item.id, '') || responseId(source.item_id, '') ? undefined : 0);
    result.item = normalizeResponsesItem(source.item, index, state, source.item_id);
  }
  if (source.item_id !== undefined || source.output_index !== undefined) {
    result.item_id = responsesItemId(source.item_id, source.output_index, state, source.item?.id);
  }
  if (source.type === 'response.completed' || source.type === 'response.incomplete') {
    result.response = normalizeResponsesResponse(source.response, source.response?.model || undefined, state);
    result.response.id = state.responseId || result.response.id;
    state.responseId = result.response.id;
  }
  return normalizeResponsesIds(result, state);
}

function responsesResponseSkeleton(id, model) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model,
    output: [],
    output_text: null,
    usage: null
  };
}

module.exports = {
  resolveEndpoint,
  openAIToAnthropic,
  anthropicToOpenAI,
  anthropicStopReason,
  openAIContentToAnthropic,
  openAIResponseToAnthropic,
  anthropicResponseToOpenAI,
  responseInputToOpenAI,
  openAIRequestToResponses,
  openAIResponseToResponses,
  responsesResponseToOpenAI,
  responsesResponseFromOpenAI,
  normalizeResponsesResponse,
  normalizeResponsesEvent,
  normalizeResponsesIds,
  responsesResponseSkeleton,
  textFromContent,
  responseId,
  isJsonSchemaField,
  isOpaqueIdField,
  responseRequestRequiresNative,
  chatRequestRequiresNative
};