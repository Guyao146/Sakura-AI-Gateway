const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const root = path.join(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-oauth-'));
  let gateway;
  let base;
  let port;
  let output = '';
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    observed.push(body.model);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'chatcmpl-oauth', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: 'oauth ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });

  const request = async (url, options = {}) => {
    const response = await fetch(`${base}${url}`, { ...options, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = null; }
    return { status: response.status, headers: response.headers, body, text };
  };
  const json = (url, body, headers = {}, method = 'POST') => request(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const form = (url, body) => request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const ok = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
  const stop = async () => {
    if (gateway && gateway.exitCode === null) { const exited = once(gateway, 'exit'); gateway.kill(); await exited; }
  };
  const start = async () => {
    gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root,
      env: { ...process.env, ADMIN_REMOTE_MODE: '', AUTHENTIK_ISSUER_URL: '', AUTHENTIK_CLIENT_ID: '', AUTHENTIK_CLIENT_SECRET: '',
        AUTHENTIK_REDIRECT_URI: '', AUTHENTIK_COOKIE_SECURE: 'false',
        SAKURA_AI_GATEWAY_DATA_DIR: temporary, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port), TRUSTED_PROXY_ADDRESSES: '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    gateway.stdout.on('data', (chunk) => { output += chunk; });
    gateway.stderr.on('data', (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (await fetch(`${base}/health`, { signal: AbortSignal.timeout(300) }).then((result) => result.ok, () => false)) return;
      assert.equal(gateway.exitCode, null, output);
      await pause(50);
    }
    throw new Error(`Gateway startup timed out: ${output}`);
  };

  try {
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const reservation = http.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    base = `http://127.0.0.1:${port}`;
    await start();
    const admin = ok(await json('/api/admin/admin-auth/users', { username: 'oauth-admin', password: 'oauth-password-123' }), 201).user;
    ok(await json('/api/admin/admin-auth/users', { username: 'other-admin', password: 'other-password-123' }), 201);
    ok(await json('/api/admin/admin-auth/remote-mode', { remoteMode: 'password' }, {}, 'PUT'));
    const originalConfig = ok(await request('/api/admin/config'));
    const source = originalConfig.localApiKeys[0];
    ok(await json('/api/admin/upstreams', { name: 'oauth-upstream', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, protocol: 'openai', authType: 'none', models: ['gpt-one', 'gpt-two'], responsesMode: 'chat' }), 201);
    const restricted = ok(await json('/api/admin/local-keys', { name: 'OAuth restricted', modelAccessMode: 'custom', allowedGroups: ['gpt'], allowedModels: ['gpt-one'] }), 201).item;
    const redirectUri = 'http://localhost:34567/callback?source=gateway';
    const client = ok(await json('/api/admin/oauth-clients', { name: '第三方测试客户端', sourceKeyId: restricted.id, redirectUris: [redirectUri] }), 201).client;
    assert.equal(client.revision, undefined);
    for (const bad of ['https://app.example.test/*', 'http://app.example.test/cb', 'https://user:pass@app.example.test/cb', 'https://app.example.test/cb#secret']) {
      const result = await json('/api/admin/oauth-clients', { name: 'bad', sourceKeyId: source.id, redirectUris: [bad] });
      assert.equal(result.status, 400);
      assert.equal(result.body.error, 'invalid_request');
    }
    for (const asset of ['authorize.html', 'authorize.js', 'auth-utils.js', 'oauth-clients.js']) assert.equal((await request(`/${asset}`)).status, 200, asset);
    const metadata = ok(await request('/.well-known/oauth-authorization-server'));
    assert.equal(metadata.issuer, base);
    assert.equal(metadata.authorization_endpoint, `${base}/oauth/authorize`);
    assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri, response_type: 'code', state: 'third-party-state',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'models:read models:invoke offline_access' });
    const authorizeUrl = `/oauth/authorize?${params}`;
    const authorizationPage = await request(authorizeUrl);
    assert.equal(authorizationPage.status, 200);
    assert.match(authorizationPage.text, /确认第三方接入/);
    assert.equal(authorizationPage.headers.get('x-frame-options'), 'DENY');
    assert.equal(authorizationPage.headers.get('cache-control'), 'no-store');
    const anonymous = await request(`/oauth/consent?${params}`);
    assert.equal(anonymous.status, 401, anonymous.text);
    assert.equal(anonymous.body.error, 'login_required', '回环免认证不能代替账号授权');
    const loginPage = await request(anonymous.body.login_url);
    assert.equal(loginPage.status, 200, '本机必须能进入账号登录页，不能循环跳转');
    assert.match(loginPage.text, /passwordLoginForm/);
    const accountStatus = await request('/auth/status?account=1');
    assert.equal(accountStatus.status, 401);
    for (const target of ['/\\evil.example', '//evil.example', '/\t/evil.example', '/a/..//evil.example', '/%2e%2e//evil.example']) {
      const response = await request(`/auth/login?returnTo=${encodeURIComponent(target)}`);
      assert.equal(response.headers.get('location'), '/');
    }
    const login = await json('/auth/password/login', { username: 'oauth-admin', password: 'oauth-password-123' });
    ok(login);
    let cookie = login.headers.get('set-cookie').split(';')[0];
    const accountHeaders = () => ({ Cookie: cookie, Origin: base });
    const consent = async (parameters = params) => ok(await request(`/oauth/consent?${parameters}`, { headers: accountHeaders() }));
    const approve = async (details, approveValue = true, headers = accountHeaders()) => json('/oauth/consent', { request_id: details.request_id, csrf_token: details.csrf_token, approve: approveValue }, headers);
    const exchange = (code, extra = {}) => form('/oauth/token', { grant_type: 'authorization_code', client_id: client.id, redirect_uri: redirectUri, code_verifier: verifier, code, ...extra });
    const tokensFor = async (parameters = params) => {
      const redirect = new URL(ok(await approve(await consent(parameters))).redirect);
      assert.equal(redirect.origin + redirect.pathname, 'http://localhost:34567/callback');
      assert.equal(redirect.searchParams.get('state'), params.get('state'));
      assert.equal(redirect.searchParams.get('source'), 'gateway');
      assert.equal(redirect.searchParams.get('iss'), base);
      return ok(await exchange(redirect.searchParams.get('code')));
    };
    const details = await consent();
    assert.deepEqual(details.models, ['gpt-one']);
    assert.equal(details.user.username, 'oauth-admin');
    assert.equal(JSON.stringify(details).includes(restricted.key), false);
    assert.equal((await approve(details, true, { Cookie: cookie, Origin: 'https://evil.example' })).status, 403);
    assert.equal((await approve(details, true, { Cookie: cookie })).status, 403);
    assert.equal((await json('/oauth/consent', { request_id: details.request_id, csrf_token: 'wrong', approve: true }, accountHeaders())).status, 403);
    const otherLogin = await json('/auth/password/login', { username: 'other-admin', password: 'other-password-123' });
    ok(otherLogin);
    const otherHeaders = { Cookie: otherLogin.headers.get('set-cookie').split(';')[0], Origin: base };
    assert.equal((await approve(details, true, otherHeaders)).status, 403, '其他账号不能确认当前账号的授权');
    const denied = new URL(ok(await approve(details, false)).redirect);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.has('code'), false);
    assert.equal((await approve(details)).status, 403);
    assert.equal(ok(await request('/api/admin/integrations')).integrations.length, 0);
    const badParams = new URLSearchParams(params);
    badParams.set('redirect_uri', 'https://evil.example/callback');
    const invalidRedirect = await request(`/oauth/authorize?${badParams}`);
    assert.equal(invalidRedirect.status, 400);
    assert.equal(invalidRedirect.headers.get('location'), null, '非法回调必须在网关报错，不能重定向');
    assert.equal((await request(`/oauth/consent?${params}&client_id=another`, { headers: accountHeaders() })).status, 400);
    const approvedCode = new URL(ok(await approve(await consent())).redirect).searchParams.get('code');
    assert.equal((await exchange(approvedCode, { code_verifier: 'x'.repeat(43) })).body.error, 'invalid_grant');
    const [first, duplicate] = await Promise.all([exchange(approvedCode), exchange(approvedCode)]);
    assert.deepEqual([first.status, duplicate.status].sort(), [200, 400]);
    let tokens = ok(first.status === 200 ? first : duplicate);
    assert.equal((first.status === 400 ? first : duplicate).body.error, 'invalid_grant');
    const bearer = (token = tokens.access_token) => ({ Authorization: `Bearer ${token}` });
    assert.deepEqual(ok(await request('/v1/models', { headers: bearer() })).data.map((item) => item.id), ['gpt-one']);
    const config = ok(await request('/api/integration/config', { headers: bearer() }));
    assert.equal(config.authorization.type, 'oauth');
    assert.equal(JSON.stringify(config).includes(restricted.key), false);
    for (const endpoint of ['chat/completions', 'messages', 'responses']) {
      const payload = (model) => endpoint === 'responses' ? { model, input: 'oauth test' } : { model, messages: [{ role: 'user', content: 'oauth test' }], max_tokens: 32 };
      ok(await json(`/v1/${endpoint}`, payload('gpt-one'), bearer()));
      assert.equal((await json(`/v1/${endpoint}`, payload('gpt-two'), bearer())).status, 403);
    }
    assert.deepEqual(observed, ['gpt-one', 'gpt-one', 'gpt-one']);
    const anthropicHeaders = { 'x-api-key': tokens.access_token, 'anthropic-version': '2023-06-01' };
    const anthropicInput = { model: 'gpt-one', max_tokens: 32, messages: [{ role: 'user', content: 'OAuth Messages' }] };
    const anthropicMessage = ok(await json('/v1/messages', anthropicInput, anthropicHeaders));
    assert.equal(anthropicMessage.type, 'message');
    assert.equal(anthropicMessage.role, 'assistant');
    assert.equal(anthropicMessage.model, 'gpt-one');
    const deniedMessages = await json('/v1/messages', { ...anthropicInput, model: 'gpt-two' }, anthropicHeaders);
    assert.equal(deniedMessages.status, 403);
    assert.equal(deniedMessages.body.type, 'error');
    assert.equal(deniedMessages.body.error.type, 'permission_error');
    assert.equal(deniedMessages.body.error.code, 'model_not_allowed');
    const keyMetrics = ok(await request('/api/admin/metrics'));
    assert.equal(keyMetrics.byKey[restricted.id].requests, 4, 'OAuth 模型调用应归入来源 Key，鉴权拒绝不计入模型请求');
    assert.equal(keyMetrics.byKey[restricted.id].successful, 4);
    assert.equal(keyMetrics.byKey[restricted.id].totalTokens, 8);
    assert.equal(JSON.stringify(keyMetrics.byKey).includes(tokens.access_token), false, '统计不能泄露 OAuth 令牌');
    assert.equal(JSON.stringify(keyMetrics.byKey).includes(restricted.key), false, '统计不能泄露来源 Key');
    // 首次连接的自动登记：接入方不预登记 Client，账号确认时选择来源 Key。
    const autoRedirect = 'http://localhost:34567/callback?source=auto';
    const autoParams = new URLSearchParams({ client_id: 'auto', name: 'Life Dashboard', redirect_uri: autoRedirect, response_type: 'code', state: 'auto-state',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'models:read models:invoke offline_access' });
    assert.equal((await request('/oauth/authorize?client_id=auto&response_type=code')).status, 400, '缺名称与 PKCE 的自动登记请求必须拒绝');
    const autoNoName = await request(`/oauth/consent?${new URLSearchParams({ client_id: 'auto', redirect_uri: autoRedirect, response_type: 'code', state: 'x', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
    assert.equal(autoNoName.status, 400, '自动登记必须携带应用名称');
    const sameHost = new URLSearchParams(autoParams);
    sameHost.set('redirect_uri', `${base}/callback`);
    assert.equal((await request(`/oauth/consent?${sameHost}`, { headers: accountHeaders() })).status, 400, '同主机名回调不能自动登记');
    assert.equal((await request(`/oauth/consent?${autoParams}`)).status, 401, '匿名不能自动登记');
    const autoDetails = ok(await request(`/oauth/consent?${autoParams}`, { headers: accountHeaders() }));
    assert.equal(autoDetails.auto, true);
    assert.equal(autoDetails.client.name, 'Life Dashboard');
    assert.equal('id' in autoDetails.client, false);
    assert.ok(autoDetails.sourceKeys.length >= 2);
    const autoSecond = ok(await request(`/oauth/consent?${new URLSearchParams([...autoParams, ['key_id', restricted.id]])}`, { headers: accountHeaders() }));
    assert.deepEqual(autoSecond.models, ['gpt-one']);
    assert.equal(autoSecond.sourceKey.id, restricted.id);
    for (const missing of [{}, { source_key_id: 'missing-key' }]) {
      const failed = await json('/oauth/consent', { request_id: autoDetails.request_id, csrf_token: autoDetails.csrf_token, approve: true, ...missing }, accountHeaders());
      assert.equal(failed.status, 400, '未选来源 Key 的确认必须失败');
    }
    const autoRedirected = new URL(ok(await json('/oauth/consent', { request_id: autoDetails.request_id, csrf_token: autoDetails.csrf_token, approve: true, source_key_id: restricted.id }, accountHeaders())).redirect);
    assert.equal(autoRedirected.origin + autoRedirected.pathname, 'http://localhost:34567/callback');
    assert.equal(autoRedirected.searchParams.get('state'), 'auto-state');
    assert.equal(autoRedirected.searchParams.get('source'), 'auto');
    assert.equal(autoRedirected.searchParams.get('iss'), base);
    const autoCode = autoRedirected.searchParams.get('code');
    const autoClient = ok(await request('/api/admin/oauth-clients')).clients.find((item) => item.redirectUris.includes(autoRedirect));
    assert.ok(autoClient, '确认授权后应自动登记应用');
    assert.equal(autoClient.name, 'Life Dashboard');
    assert.equal(autoClient.sourceKeyId, restricted.id);
    const wrongVerifier = crypto.randomBytes(32).toString('base64url');
    assert.equal((await form('/oauth/token', { grant_type: 'authorization_code', client_id: 'auto', redirect_uri: autoRedirect, code_verifier: wrongVerifier, code: autoCode })).body.error, 'invalid_grant');
    assert.equal((await form('/oauth/token', { grant_type: 'authorization_code', client_id: client.id, redirect_uri: autoRedirect, code_verifier: verifier, code: autoCode })).body.error, 'invalid_grant', '自动登记的授权码不能绑给其他应用');
    assert.equal((await form('/oauth/token', { grant_type: 'authorization_code', client_id: 'auto', redirect_uri: `${autoRedirect}&changed=1`, code_verifier: verifier, code: autoCode })).body.error, 'invalid_grant', '回调地址必须逐字符匹配');
    const autoTokens = ok(await form('/oauth/token', { grant_type: 'authorization_code', client_id: 'auto', redirect_uri: autoRedirect, code_verifier: verifier, code: autoCode }));
    assert.equal(autoTokens.client_id, autoClient.id, '换码响应必须带回实际 Client ID');
    const autoBearer = { Authorization: `Bearer ${autoTokens.access_token}` };
    ok(await request('/v1/models', { headers: autoBearer }));
    const autoConfig = ok(await request('/api/integration/config', { headers: autoBearer }));
    assert.equal(autoConfig.authorization.clientId, autoClient.id);
    assert.equal(autoConfig.authorization.type, 'oauth');
    assert.equal(JSON.stringify(autoConfig).includes(source.key), false, '自动登记也不能泄露原始 Key');
    ok(await json('/v1/chat/completions', { model: 'gpt-one', messages: [{ role: 'user', content: 'auto flow' }] }, autoBearer));
    const autoRefreshed = ok(await form('/oauth/token', { grant_type: 'refresh_token', client_id: autoClient.id, refresh_token: autoTokens.refresh_token }));
    assert.equal((await request('/v1/models', { headers: autoBearer })).status, 401, '刷新后旧访问令牌立即失效');
    const refreshedBearer = { Authorization: `Bearer ${autoRefreshed.access_token}` };
    ok(await request('/v1/models', { headers: refreshedBearer }));
    // 相同回调再次确认应复用已登记应用，而不是重复创建
    const autoAgain = ok(await request(`/oauth/consent?${autoParams}`, { headers: accountHeaders() }));
    const againRedirect = new URL(ok(await json('/oauth/consent', { request_id: autoAgain.request_id, csrf_token: autoAgain.csrf_token, approve: true, source_key_id: restricted.id }, accountHeaders())).redirect);
    const againTokens = ok(await form('/oauth/token', { grant_type: 'authorization_code', client_id: 'auto', redirect_uri: autoRedirect, code_verifier: verifier, code: againRedirect.searchParams.get('code') }));
    assert.equal(againTokens.client_id, autoClient.id);
    assert.equal(ok(await request('/api/admin/oauth-clients')).clients.filter((item) => item.redirectUris.includes(autoRedirect)).length, 1, '不能重复登记');
    assert.equal((await request('/v1/models', { headers: refreshedBearer })).status, 401, '复用登记应使该应用的旧令牌失效');
    ok(await form('/oauth/revoke', { client_id: autoClient.id, token: againTokens.refresh_token }));
    assert.equal((await request('/v1/models', { headers: { Authorization: `Bearer ${againTokens.access_token}` } })).status, 401);
    // 无论回环、远程，还是附带管理 Cookie，都不允许模型令牌跨越到管理面。
    const remoteHeaders = { ...bearer(), 'X-Forwarded-For': '203.0.113.42' };
    for (const headers of [bearer(), remoteHeaders, { ...accountHeaders(), ...bearer() }, { Authorization: `bearer ${tokens.access_token}` }, { 'X-API-Key': tokens.access_token }, bearer(tokens.refresh_token)]) {
      for (const endpoint of ['/api/admin/config', '/api/admin/config/export', '/api/admin/oauth-clients']) {
        assert.equal((await request(endpoint, { headers })).status, 403, endpoint);
      }
    }
    assert.equal((await request('/v1/models', { headers: bearer(tokens.refresh_token) })).status, 401);
    const rawConfig = fs.readFileSync(path.join(temporary, 'config.json'), 'utf8');
    for (const secret of [tokens.access_token, tokens.refresh_token, approvedCode, 'oauth-password-123']) assert.equal(rawConfig.includes(secret), false, '令牌、授权码、密码不能明文落盘');
    assert.equal(output.includes(tokens.access_token), false);
    const backup = ok(await request('/api/admin/config/export'));
    assert.equal(backup.config.oauthClients[0].id, client.id);
    ok(await json('/api/admin/config/import', { ...backup, preserveCredentials: true }));
    ok(await request('/v1/models', { headers: bearer() }));
    const myGrants = ok(await request('/oauth/grants', { headers: accountHeaders() })).grants;
    // 前面自动登记流程会留下已撤销的授权记录；这里只统计仍然有效的授权。
    assert.equal(myGrants.filter((item) => item.status === 'active').length, 1);
    assert.equal(JSON.stringify(myGrants).includes('TokenHash'), false);
    assert.deepEqual(ok(await request('/oauth/grants', { headers: otherHeaders })).grants, []);
    assert.equal((await json('/oauth/grants/revoke', { id: myGrants[0].id }, otherHeaders)).status, 404);
    const rotated = ok(await form('/oauth/token', { grant_type: 'refresh_token', client_id: client.id, refresh_token: tokens.refresh_token }));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    const revokedMessages = await json('/v1/messages', anthropicInput, anthropicHeaders);
    assert.equal(revokedMessages.status, 401);
    assert.equal(revokedMessages.body.type, 'error');
    assert.equal(revokedMessages.body.error.type, 'authentication_error');
    const replay = await form('/oauth/token', { grant_type: 'refresh_token', client_id: client.id, refresh_token: tokens.refresh_token });
    assert.equal(replay.body.error, 'invalid_grant');
    assert.equal((await request('/v1/models', { headers: bearer(rotated.access_token) })).status, 401, '刷新令牌重放应撤销该授权全部令牌');
    tokens = await tokensFor();
    await stop();
    await start();
    ok(await request('/v1/models', { headers: bearer() }), 200);
    const relogin = await json('/auth/password/login', { username: 'oauth-admin', password: 'oauth-password-123' });
    ok(relogin);
    cookie = relogin.headers.get('set-cookie').split(';')[0];
    const grant = ok(await request('/api/admin/integrations')).integrations.find((item) => item.type === 'oauth' && item.status === 'active');
    ok(await json(`/api/admin/integrations/${grant.id}/revoke`, {}));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    assert.equal((await form('/oauth/token', { grant_type: 'refresh_token', client_id: client.id, refresh_token: tokens.refresh_token })).status, 400);
    const readParams = new URLSearchParams(params);
    readParams.set('scope', 'models:read');
    const readOnly = await tokensFor(readParams);
    assert.equal(readOnly.refresh_token, undefined);
    ok(await request('/api/integration/config', { headers: bearer(readOnly.access_token) }));
    const noInvoke = await json('/v1/chat/completions', { model: 'gpt-one', messages: [] }, bearer(readOnly.access_token));
    assert.equal(noInvoke.status, 403);
    assert.equal(noInvoke.body.error.code, 'insufficient_scope');
    const noMessages = await json('/v1/messages', anthropicInput, { 'x-api-key': readOnly.access_token });
    assert.equal(noMessages.status, 403);
    assert.equal(noMessages.body.type, 'error');
    assert.equal(noMessages.body.error.type, 'permission_error');
    assert.equal(noMessages.body.error.code, 'insufficient_scope');
    const invokeParams = new URLSearchParams(params);
    invokeParams.set('scope', 'models:invoke');
    const invokeOnly = await tokensFor(invokeParams);
    assert.equal((await request('/v1/models', { headers: bearer(invokeOnly.access_token) })).status, 403);
    assert.equal((await request('/api/integration/config', { headers: bearer(invokeOnly.access_token) })).status, 403);
    tokens = await tokensFor();
    ok(await json(`/api/admin/oauth-clients/${client.id}`, { enabled: false }, {}, 'PUT'));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    ok(await json(`/api/admin/oauth-clients/${client.id}`, { enabled: true }, {}, 'PUT'));
    tokens = await tokensFor();
    ok(await json(`/api/admin/local-keys/${restricted.id}`, { allowedModels: [] }, {}, 'PUT'));
    assert.deepEqual(ok(await request('/v1/models', { headers: bearer() })).data, []);
    ok(await json(`/api/admin/local-keys/${restricted.id}`, { allowedModels: ['gpt-one'] }, {}, 'PUT'));
    const waitingCode = new URL(ok(await approve(await consent())).redirect).searchParams.get('code');
    ok(await json(`/api/admin/local-keys/${restricted.id}`, { enabled: false }, {}, 'PUT'));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    ok(await json(`/api/admin/local-keys/${restricted.id}`, { enabled: true }, {}, 'PUT'));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401, '重新启用来源 Key 不能复活旧授权');
    assert.equal((await exchange(waitingCode)).body.error, 'invalid_grant', '停用前未兑换的授权码也必须失效');
    tokens = await tokensFor();
    const currentPassword = 'oauth-rotated-password-456';
    ok(await json(`/api/admin/admin-auth/users/${admin.id}`, { username: 'oauth-admin', password: currentPassword }, {}, 'PUT'));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401, '修改账号密码后旧授权失效');
    assert.equal((await request('/oauth/grants', { headers: accountHeaders() })).status, 401, '旧账号会话也必须失效');
    const updatedLogin = await json('/auth/password/login', { username: 'oauth-admin', password: currentPassword });
    ok(updatedLogin);
    cookie = updatedLogin.headers.get('set-cookie').split(';')[0];
    tokens = await tokensFor();
    ok(await json(`/api/admin/admin-auth/users/${admin.id}`, { enabled: false }, {}, 'PUT'));
    ok(await json(`/api/admin/admin-auth/users/${admin.id}`, { enabled: true }, {}, 'PUT'));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401, '重新启用账号不能恢复旧授权');
    assert.equal((await request('/oauth/grants', { headers: accountHeaders() })).status, 401, '停用后的旧会话不能恢复');
    const restoredLogin = await json('/auth/password/login', { username: 'oauth-admin', password: currentPassword });
    ok(restoredLogin);
    cookie = restoredLogin.headers.get('set-cookie').split(';')[0];
    tokens = await tokensFor();
    const owned = ok(await request('/oauth/grants', { headers: accountHeaders() })).grants.find((item) => item.active);
    ok(await json('/oauth/grants/revoke', { id: owned.id }, accountHeaders()));
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    tokens = await tokensFor();
    ok(await request(`/api/admin/local-keys/${restricted.id}`, { method: 'DELETE' }));
    assert.equal((await request('/api/integration/config', { headers: bearer() })).status, 401);
    assert.equal((await request('/v1/models', { headers: bearer() })).status, 401);
    assert.equal((await form('/oauth/revoke', { client_id: client.id, token: 'unknown' })).status, 200);
    ok(await request('/v1/models', { headers: bearer(source.key) }), 200);
    assert.equal((await request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await json('/oauth/token', { grant_type: 'password', username: 'oauth-admin', password: currentPassword })).body.error, 'unsupported_grant_type');
    assert.equal((await json('/oauth/token', { grant_type: 'authorization_code', code: { nested: 'bad' } })).body.error, 'invalid_request');
    assert.equal((await request('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&grant_type=authorization_code' })).body.error, 'invalid_request');
    assert.equal((await json('/oauth/token', { grant_type: 'refresh_token', padding: 'x'.repeat(17000) })).status, 413);
    for (const headers of [{ Host: 'gateway.example.test', 'X-Forwarded-Proto': 'https' }, { Host: `127.0.0.1:${port}`, 'X-Forwarded-For': '203.0.113.42' }]) {
      // Node fetch 会丢弃自定义 Host；安全边界测试必须真的发送伪造头。
      const status = await new Promise((resolve, reject) => {
        const req = http.get(`${base}/.well-known/oauth-authorization-server`, { headers, signal: AbortSignal.timeout(10000) }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
      });
      assert.equal(status, 400, `不可信代理/远程来源不能绕过 HTTPS：${JSON.stringify(headers)}`);
    }
    const fullBackup = ok(await request('/api/admin/config/export'));
    const clientsBefore = ok(await request('/api/admin/oauth-clients')).clients.map((item) => item.id);
    const invalidBackup = JSON.parse(JSON.stringify(fullBackup));
    invalidBackup.preserveCredentials = false;
    invalidBackup.config.oauthClients[0].redirectUris = ['http://evil.example/callback'];
    assert.equal((await json('/api/admin/config/import', invalidBackup)).status, 400);
    assert.deepEqual(ok(await request('/api/admin/oauth-clients')).clients.map((item) => item.id), clientsBefore, '非法导入不能部分改写配置');
    ok(await json('/api/admin/config/import', { ...fullBackup, preserveCredentials: false }));
    assert.equal((await request('/oauth/grants', { headers: accountHeaders() })).status, 401, '导入凭据必须清除旧登录会话');
    const oldBackup = JSON.parse(JSON.stringify(fullBackup));
    delete oldBackup.config.oauthClients;
    delete oldBackup.config.oauthGrants;
    ok(await json('/api/admin/config/import', { ...oldBackup, preserveCredentials: false }));
    assert.deepEqual(ok(await request('/api/admin/oauth-clients')).clients, [], '旧备份没有 OAuth 字段也可以导入');
    ok(await json('/api/admin/config/import', { ...fullBackup, preserveCredentials: false }));
    if (process.env.GATEWAY_BROWSER_TEST === '1' || process.argv.includes('--browser')) {
      const browser = require('./oauth.browser');
      await browser(base, { username: 'oauth-admin', password: currentPassword, sourceKeyId: source.id });
    }
    console.log('OAuth account authorization integration tests passed');
  } finally {
    await stop();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });