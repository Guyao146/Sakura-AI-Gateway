const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-modalities-'));
const observed = [];
let bareCatalog = false;
let uppercaseCatalog = false;
let failTranslation = false;
let translationMode = 'ok';
let nativeUnavailable = false;
let targetFailure = false;
let gateway;
let base;
let port;
const models = [
  { id: 'plain', input_modalities: ['text'], output_modalities: ['text'], supports_thinking: false },
  { id: 'vision', architecture: { input_modalities: ['text', 'image', 'audio', 'video', 'file'], output_modalities: ['text'] }, reasoning_effort: ['low', 'high'] },
  { id: 'unknown' }, { id: 'probe-only' },
  { id: 'reasoning-extra', reasoning: { effort: { enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] } } }
];
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  observed.push({ url: req.url, body });
  res.setHeader('Content-Type', 'application/json');
  const json = (status, payload) => { res.statusCode = status; res.end(JSON.stringify(payload)); };
  if (req.url === '/v1/models') return json(200, { data: bareCatalog ? models.map(({ id }) => ({ id: uppercaseCatalog ? id.toUpperCase() : id })) : models });
  if (nativeUnavailable && req.url === '/v1/responses') return json(404, { error: { message: 'endpoint unavailable' } });
  if (targetFailure && body.model === 'plain') return json(503, { error: { message: 'retry target' } });
  if (body.model === 'vision' && translationMode === 'timeout') return;
  if (body.model === 'vision' && failTranslation) return json(200, { error: { message: 'translation unavailable' } });
  const text = body.model === 'vision' ? (translationMode === 'empty' ? '' : '附件中是一只猫。') : 'target answer';
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ id: 'chatcmpl-test', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  if (req.url === '/v1/responses') return json(200, { id: 'resp_test', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } });
  if (req.url === '/v1/messages') return json(200, { id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 5 } });
  return json(200, { id: 'chatcmpl-test', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: body.model === 'vision' && translationMode === 'truncated' ? 'length' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
});

async function request(url, method = 'GET', body, key) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: response.status, body: parsed };
}
async function start() {
  gateway = spawn(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  gateway.stdout.on('data', (chunk) => { output += chunk; });
  gateway.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 200; i += 1) {
    if (output.includes('本地管理访问：无需认证')) return;
    if (gateway.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`启动超时 ${output}`);
}
async function stop() {
  if (!gateway || gateway.exitCode !== null) return;
  const done = once(gateway, 'exit');
  gateway.kill();
  await done;
}
const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } };
const chatInput = (model, part = image) => ({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'before' }, part, { type: 'text', text: 'after' }] }] });
const checked = (result, status = 200) => { assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };
const posts = () => observed.filter((item) => item.url !== '/v1/models');

async function main() {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reservation = http.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  try {
    await start();
    const key = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'))).localApiKeys[0].key;
    const added = checked(await request('/api/admin/upstreams', 'POST', { name: 'modalities-test', baseUrl: `http://127.0.0.1:${upstream.address().port}`, protocol: 'openai', authType: 'none', models: models.map(({ id }) => id) }), 201);
    const upstreamId = added.id;
    checked(await request('/api/admin/model-catalog/sync', 'POST', {}));
    const refresh = checked(await request('/api/admin/model-catalog/capabilities', 'POST', { upstreamId, modelId: 'VISION', probeThinking: true }));
    assert.deepEqual(refresh.model.inputModalities, ['text', 'image', 'audio', 'video', 'file']);
    assert.deepEqual(refresh.model.thinkingLevels, ['low', 'high']);
    assert.equal(posts().length, 0, '声明档位不应再探测');
    checked(await request('/api/admin/model-catalog/capabilities', 'POST', { upstreamId, modelId: 'probe-only', probeThinking: true }));
    assert.equal(posts().length, 3);
    assert(posts().every(({ body }) => body.model === 'probe-only'), '只探测指定模型');
    observed.length = 0;
    bareCatalog = true;
    checked(await request('/api/admin/model-catalog/sync', 'POST', {}));
    let catalog = checked(await request('/api/admin/model-catalog'));
    assert.deepEqual(catalog.upstreams[0].models.find(({ id }) => id === 'vision').inputModalities, refresh.model.inputModalities);
    uppercaseCatalog = true;
    checked(await request('/api/admin/model-catalog/sync', 'POST', {}));
    catalog = checked(await request('/api/admin/model-catalog'));
    assert.deepEqual(catalog.upstreams[0].models.find(({ id }) => id === 'vision').inputModalities, refresh.model.inputModalities, '只更改大小写不能丢失模态');
    const extra = catalog.upstreams[0].models.find(({ id }) => id === 'reasoning-extra');
    assert.deepEqual(extra.thinkingLevels, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    uppercaseCatalog = false;
    bareCatalog = false;
    const route = async (localModel, upstreamModel, modalityTranslator = '') => checked(await request('/api/admin/routes', 'POST', { upstreamId, localModel, upstreamModel, modalityTranslator }), 201);
    await route('captioner', 'vision');
    const effortRoute = await route('extra-effort', 'reasoning-extra');
    for (const level of ['none', 'minimal', 'xhigh']) {
      checked(await request(`/api/admin/routes/${effortRoute.id}`, 'PUT', { ...effortRoute, thinkingLevel: level }));
      checked(await request('/v1/chat/completions', 'POST', { model: 'extra-effort', messages: [{ role: 'user', content: 'hi' }] }, key));
      assert.equal(posts().at(-1).body.reasoning_effort, level);
      checked(await request('/v1/responses', 'POST', { model: 'extra-effort', input: 'hi' }, key));
      assert.equal(posts().at(-1).body.reasoning.effort, 'none');
    }
    checked(await request('/v1/chat/completions', 'POST', { model: 'unknown', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' }, key));
    assert.equal(posts().at(-1).body.reasoning_effort, undefined, '未声明 none 的旧站保留原有省略行为');
    const target = await route('target', 'plain', 'captioner');
    await route('blocked', 'plain');
    await route('loop', 'plain', 'blocked');
    await route('missing-translator', 'plain', 'deleted');
    const before = posts().length;
    for (const [endpoint, body] of [
      ['chat/completions', chatInput('blocked')],
      ['messages', { model: 'blocked', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }] }] }],
      ['responses', { model: 'blocked', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }] }] }]
    ]) for (const stream of [false, true]) {
      const denied = checked(await request(`/v1/${endpoint}`, 'POST', { ...body, stream }, key), 400);
      assert.equal(denied.error.code, 'unsupported_input_modality');
    }
    checked(await request('/v1/chat/completions', 'POST', chatInput('loop'), key), 400);
    checked(await request('/v1/chat/completions', 'POST', chatInput('missing-translator'), key), 400);
    assert.equal(posts().length, before, '拒绝与循环不得发送请求');
    checked(await request('/v1/chat/completions', 'POST', { ...chatInput('target'), modalities: ['text', 'audio'] }, key), 400);
    const oversized = chatInput('target');
    oversized.messages[0].content = Array.from({ length: 17 }, () => image);
    const limited = checked(await request('/v1/chat/completions', 'POST', oversized, key), 400);
    assert.equal(limited.error.code, 'modality_translation_limit');
    assert.equal(posts().length, before, '附件数量与输出模态拒绝不应收费');
    const restricted = checked(await request('/api/admin/local-keys', 'POST', { name: 'target-only', modelAccessMode: 'custom', allowedGroups: ['plain'], allowedModels: ['target'] }), 201).item;
    const forbidden = checked(await request('/v1/chat/completions', 'POST', chatInput('target'), restricted.key), 403);
    assert.equal(forbidden.error.code, 'model_not_allowed');
    assert.equal(posts().length, before);

    checked(await request('/v1/chat/completions', 'POST', chatInput('target'), key));
    assert.equal(posts().at(-2).body.model, 'vision');
    assert.equal(posts().at(-2).body.stream, false);
    assert(!JSON.stringify(posts().at(-2).body).includes('before'), '不向转译模型发送整个对话');
    const sent = posts().at(-1).body;
    assert.equal(sent.model, 'plain');
    assert.deepEqual(sent.messages[0].content.map((part) => part.type), ['text', 'text', 'text']);
    assert.equal(sent.messages[0].content[0].text, 'before');
    assert.match(sent.messages[0].content[1].text, /附件中是一只猫/);
    assert.equal(sent.messages[0].content[2].text, 'after');

    for (const part of [{ type: 'input_audio', input_audio: { data: 'abcd', format: 'wav' } }, { type: 'video_url', video_url: { url: 'https://example.test/video' } }, { type: 'file', file: { filename: 'test.pdf', file_data: 'data:application/pdf;base64,abcd' } }]) {
      checked(await request('/v1/chat/completions', 'POST', chatInput('target', part), key));
      assert.equal(posts().at(-2).body.messages[0].content[1].type, part.type);
      assert.equal(posts().at(-1).body.messages[0].content[1].type, 'text');
    }
    const duplicate = chatInput('target');
    duplicate.messages[0].content.push(image);
    let count = posts().length;
    checked(await request('/v1/chat/completions', 'POST', duplicate, key));
    assert.equal(posts().length - count, 2, '重复附件只调用一次转译');
    checked(await request('/v1/messages', 'POST', { model: 'target', messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image' } }] }] }, key));
    assert.equal(posts().at(-2).body.messages[0].content[1].type, 'image_url', 'Anthropic 图片转成 Chat 图片');
    checked(await request('/v1/responses', 'POST', { model: 'target', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image' }] }] }, key));
    assert.equal(posts().at(-2).url, '/v1/responses');
    assert.equal(posts().at(-1).body.input[0].content[0].type, 'input_text');
    nativeUnavailable = true;
    checked(await request('/v1/responses', 'POST', { model: 'target', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.test/image' }] }] }, key));
    assert.equal(posts().at(-1).url, '/v1/chat/completions', '转译和目标均可自动回退到 Chat');
    nativeUnavailable = false;
    const stream = checked(await request('/v1/chat/completions', 'POST', { ...chatInput('target'), stream: true }, key));
    assert.match(stream, /target answer/);
    assert.match(stream, /\[DONE\]/);
    assert.equal(posts().at(-2).body.stream, false);
    count = posts().length;
    checked(await request('/v1/chat/completions', 'POST', chatInput('vision'), key));
    checked(await request('/v1/chat/completions', 'POST', chatInput('unknown'), key));
    assert.equal(posts().length - count, 2, '支持或未知能力原样透传');
    assert.equal(posts().at(-1).body.messages[0].content[1].type, 'image_url');
    failTranslation = true;
    count = posts().length;
    checked(await request('/v1/chat/completions', 'POST', chatInput('target'), key), 502);
    assert.equal(posts().length - count, 1, '转译失败不能调用目标');
    failTranslation = false;
    for (translationMode of ['empty', 'truncated']) {
      count = posts().length;
      checked(await request('/v1/chat/completions', 'POST', chatInput('target'), key), 502);
      assert.equal(posts().length - count, 1);
    }
    translationMode = 'ok';
    const settings = checked(await request('/api/admin/config')).settings;
    checked(await request('/api/admin/settings', 'PUT', { ...settings, upstreamTimeoutMs: 1000 }));
    translationMode = 'timeout';
    checked(await request('/v1/chat/completions', 'POST', chatInput('target'), key), 502);
    translationMode = 'ok';
    checked(await request('/api/admin/settings', 'PUT', settings));

    // 候选站逐个判定能力：第一个不支持时可继续使用支持图片的备用站。
    const second = checked(await request('/api/admin/upstreams', 'POST', { name: 'second', baseUrl: `http://127.0.0.1:${upstream.address().port}`, protocol: 'openai', authType: 'none', modelCatalog: [{ id: 'plain', input_modalities: ['text', 'image'] }], models: ['plain'] }), 201);
    const pooled = checked(await request('/api/admin/routes', 'POST', { localModel: 'pooled', upstreamModel: 'plain', upstreamId, fallbackUpstreamIds: [second.id] }), 201);
    count = posts().length;
    checked(await request('/v1/chat/completions', 'POST', chatInput('pooled'), key));
    assert.equal(posts().length - count, 1);
    assert.equal(posts().at(-1).body.messages[0].content[1].type, 'image_url');
    // 备用站也需要转译时，原始请求重建，但已完成的转译结果复用。
    checked(await request(`/api/admin/upstreams/${second.id}`, 'PUT', { ...second, modelCatalog: [{ id: 'plain', input_modalities: ['text'] }] }));
    checked(await request(`/api/admin/routes/${pooled.id}`, 'PUT', { ...pooled, modalityTranslator: 'captioner' }));
    targetFailure = true;
    count = posts().length;
    checked(await request('/v1/chat/completions', 'POST', chatInput('pooled'), key), 503);
    assert.equal(posts().slice(count).filter(({ body }) => body.model === 'vision').length, 1);
    assert.equal(posts().slice(count).filter(({ body }) => body.model === 'plain').length, 2);
    targetFailure = false;

    const anthropic = checked(await request('/api/admin/upstreams', 'POST', { name: 'anthropic', baseUrl: `http://127.0.0.1:${upstream.address().port}`, protocol: 'anthropic', authType: 'none', models: ['vision'], modelCatalog: [models[1]] }), 201);
    checked(await request('/api/admin/routes', 'POST', { localModel: 'anthropic-captioner', upstreamModel: 'vision', upstreamId: anthropic.id }), 201);
    checked(await request('/api/admin/routes', 'POST', { localModel: 'anthropic-extra', upstreamModel: 'vision', upstreamId: anthropic.id, thinkingLevel: 'xhigh' }), 201);
    count = posts().length;
    const unmappedEffort = checked(await request('/v1/messages', 'POST', { model: 'anthropic-extra', messages: [{ role: 'user', content: 'hi' }] }, key), 400);
    assert.equal(unmappedEffort.error.code, 'unsupported_thinking_level');
    assert.equal(posts().length, count);
    const anthropicTarget = await route('anthropic-target', 'plain', 'anthropic-captioner');
    checked(await request('/v1/chat/completions', 'POST', chatInput('anthropic-target'), key));
    assert.equal(posts().at(-2).url, '/v1/messages');
    assert.equal(posts().at(-2).body.messages[0].content[1].type, 'image');
    // 不同站点的 file_id 不能分享，拒绝前不能调用转译模型。
    const remoteTarget = await route('remote-file', 'plain', 'anthropic-captioner');
    count = posts().length;
    checked(await request('/v1/responses', 'POST', { model: remoteTarget.localModel, input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-private' }] }] }, key), 400);
    assert.equal(posts().length, count);
    checked(await request(`/api/admin/routes/${anthropicTarget.id}`, 'PUT', { ...anthropicTarget, modalityTranslator: '' }));
    checked(await request('/v1/chat/completions', 'POST', chatInput('anthropic-target'), key), 400);
    // 原生 file_id 不能通过跨协议转换静默消失。
    const directChat = await route('chat-vision', 'vision');
    checked(await request(`/api/admin/routes/${directChat.id}`, 'PUT', { ...directChat, responsesMode: 'chat' }));
    count = posts().length;
    const conversion = checked(await request('/v1/responses', 'POST', { model: 'chat-vision', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }] }, key), 400);
    assert.equal(conversion.error.code, 'unsupported_modality_conversion');
    assert.equal(posts().length, count);
    checked(await request(`/api/admin/routes/${directChat.id}`, 'PUT', { ...directChat, responsesMode: 'auto' }));
    nativeUnavailable = true;
    const fallbackConversion = checked(await request('/v1/responses', 'POST', { model: 'chat-vision', input: [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-1' }] }] }, key), 400);
    assert.equal(fallbackConversion.error.type, 'unsupported_agent_capability', '文件请求原本要求原生 Responses，不允许有损回退');
    nativeUnavailable = false;
    checked(await request(`/api/admin/routes/${target.id}`, 'PUT', { ...target, modalityTranslator: 'TARGET' }), 400);

    const selected = checked(await request('/api/admin/model-selections', 'PUT', { selections: [{ upstreamId, upstreamModel: 'plain', localModel: 'selected', modalityTranslator: 'captioner' }] }));
    assert.equal(selected.selections[0].modalityTranslator, 'captioner');
    const exported = checked(await request('/api/admin/config/export'));
    checked(await request('/api/admin/config/import', 'POST', { config: exported.config }));
    await stop();
    await start();
    catalog = checked(await request('/api/admin/model-catalog'));
    assert.equal(catalog.selections[0].modalityTranslator, 'captioner');
    assert.deepEqual(catalog.upstreams[0].models.find(({ id }) => id === 'vision').inputModalities, refresh.model.inputModalities);
    checked(await request('/v1/chat/completions', 'POST', chatInput('selected'), key));
    const saved = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json')));
    assert.equal(saved.routes.find(({ localModel }) => localModel === 'selected').modalityTranslator, 'captioner');
    assert.equal(saved.routes.find(({ localModel }) => localModel === 'extra-effort').thinkingLevel, 'xhigh');
    assert.deepEqual(catalog.upstreams[0].models.find(({ id }) => id === 'reasoning-extra').thinkingLevels, extra.thinkingLevels);
    const logs = fs.readFileSync(path.join(dataDirectory, 'metrics-log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert(logs.some((entry) => entry.model === 'captioner' && entry.success), '额外转译调用应计入统计');
    const translations = logs.filter((entry) => entry.id.includes('-translation-'));
    assert(translations.some((entry) => entry.success) && translations.some((entry) => !entry.success));
    assert(translations.every((entry) => entry.keyId === saved.localApiKeys[0].id && entry.keyName), '成功和失败的转译子请求都应记录来源 Key');
    const metrics = checked(await request('/api/admin/metrics'));
    const keyLogs = logs.filter((entry) => entry.keyId === saved.localApiKeys[0].id);
    assert.equal(metrics.byKey[saved.localApiKeys[0].id].requests, keyLogs.length);
    assert.equal(metrics.byKey[saved.localApiKeys[0].id].totalTokens, keyLogs.reduce((sum, entry) => sum + entry.usage.totalTokens, 0));
    if (process.env.GATEWAY_BROWSER_TEST === '1') await require('./modalities.browser')(base, upstreamId);
    console.log('modality integration tests passed');
  } finally {
    await stop();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });