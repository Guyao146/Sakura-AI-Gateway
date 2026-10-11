const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { OAuthProvider, ACCESS_TTL_MS, REFRESH_TTL_MS, normalizeOAuthState, normalizeOAuthClient } = require('../src/oauth');
const { hashToken } = require('../src/integration');
const { safeReturnTo } = require('../public/auth-utils');

const config = {
  localApiKeys: [{ id: 'key_test', key: 'secret-never-returned', name: '测试权限', enabled: true, modelAccessMode: 'all' }],
  upstreams: [{ enabled: true, models: ['gpt-one', 'gpt-two'] }], routes: [], oauthClients: [], oauthGrants: []
};
let now = Date.parse('2026-10-11T12:00:00Z');
let subjectActive = true;
let saved = 0;
let failSave = false;
const provider = new OAuthProvider({ getConfig: () => config, save: () => { if (failSave) throw new Error('disk unavailable'); saved += 1; }, isSubjectActive: () => subjectActive, now: () => now });
const issuer = 'https://gateway.example.test';
const subject = { id: 'local:admin_a', mode: 'password', username: 'alice', issuer: '', credentialVersion: hashToken('password-hash') };
const verifier = 'a'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const client = provider.saveClient({ name: 'Test client', redirectUris: ['https://client.example.test/callback'], sourceKeyId: 'key_test' });
assert.equal(client.revision, undefined);
assert.equal(client.clientSecret, undefined);
const parameters = { client_id: client.id, redirect_uri: client.redirectUris[0], response_type: 'code', state: 'csrf-state', code_challenge: challenge, code_challenge_method: 'S256', scope: 'models:read models:invoke offline_access' };
const consent = (params = parameters) => provider.createConsent(params, 'session-a', subject, issuer);
const approve = (details, approveValue = true) => provider.decideConsent({ request_id: details.request_id, csrf_token: details.csrf_token, approve: approveValue }, 'session-a', subject, issuer);
const exchange = (code, extra = {}) => provider.exchangeCode({ client_id: client.id, code, redirect_uri: client.redirectUris[0], code_verifier: verifier, ...extra }, issuer);
const authorize = () => exchange(new URL(approve(consent()).redirect).searchParams.get('code'));
const rejects = (fn, code) => assert.throws(fn, (error) => error.oauthCode === code);

for (const target of ['/\\evil.example', '//evil.example', '/\t/evil.example', 'https://evil.example', '/a/..//evil.example', '/%2e%2e//evil.example']) assert.equal(safeReturnTo(target), '/');
for (const target of ['/', '/oauth/authorize?state=a%2Fb%5Cc', '/%2fexample', '/a/b/../c#hash', null, {}, '/'.repeat(5000)]) {
  const safe = safeReturnTo(target);
  assert.equal(new URL(safe, 'https://gateway.invalid').origin, 'https://gateway.invalid');
  assert.equal(safeReturnTo(safe), safe, '安全回跳校验必须幂等');
}
assert.equal(safeReturnTo('/oauth/authorize?client_id=test&state=abc'), '/oauth/authorize?client_id=test&state=abc');
for (const redirect of ['https://example.test/*', 'http://example.test/callback', 'javascript:alert(1)', 'https://u:p@example.test/cb', 'https://example.test/cb#fragment', 'https://example.test/cb?code=bad']) {
  rejects(() => normalizeOAuthClient({ name: 'bad', sourceKeyId: 'key_test', redirectUris: [redirect] }), 'invalid_request');
}
for (const redirect of ['http://127.0.0.1:3000/callback', 'http://[::1]:3000/callback', 'https://example.test/callback']) {
  assert.equal(normalizeOAuthClient({ name: 'valid', sourceKeyId: 'key_test', redirectUris: [redirect] }).redirectUris[0], redirect);
}
rejects(() => consent({ ...parameters, redirect_uri: 'https://client.example.test/callback/other' }), 'invalid_request');
rejects(() => consent({ ...parameters, code_challenge_method: 'plain' }), 'invalid_request');
rejects(() => consent({ ...parameters, state: '' }), 'invalid_request');
rejects(() => consent({ ...parameters, scope: 'admin' }), 'invalid_scope');
rejects(() => consent({ ...parameters, response_type: 'token' }), 'unsupported_response_type');
const details = consent();
assert.equal(JSON.stringify(details).includes('secret-never-returned'), false);
rejects(() => provider.decideConsent({ request_id: details.request_id, csrf_token: details.csrf_token, approve: true }, 'other-session', subject, issuer), 'invalid_request');
rejects(() => provider.decideConsent({ request_id: details.request_id, csrf_token: 'bad', approve: true }, 'session-a', subject, issuer), 'invalid_request');
const denied = new URL(approve(details, false).redirect);
assert.equal(denied.searchParams.get('error'), 'access_denied');
assert.equal(denied.searchParams.get('state'), parameters.state);
assert.equal(denied.searchParams.get('iss'), issuer);
assert.equal(config.oauthGrants.length, 0);
rejects(() => approve(details), 'invalid_request');

const approval = new URL(approve(consent()).redirect);
const code = approval.searchParams.get('code');
rejects(() => exchange(code, { code_verifier: 'b'.repeat(43) }), 'invalid_grant');
rejects(() => exchange(code, { redirect_uri: 'https://client.example.test/other' }), 'invalid_grant');
const tokens = exchange(code);
assert.equal(tokens.expires_in, ACCESS_TTL_MS / 1000);
assert.equal(tokens.refresh_token_expires_in, REFRESH_TTL_MS / 1000);
assert.equal(tokens.token_type, 'Bearer');
rejects(() => exchange(code), 'invalid_grant');
const access = provider.authenticate(tokens.access_token, 'models:invoke');
assert.equal(access.key.id, 'key_test');
assert.equal(access.key.key, undefined);
rejects(() => provider.authenticate(tokens.refresh_token), 'invalid_token');
rejects(() => provider.authenticate(tokens.access_token, 'admin'), 'insufficient_scope');
assert.equal(JSON.stringify(config).includes(tokens.access_token), false);
assert.equal(JSON.stringify(config).includes(tokens.refresh_token), false);
Object.assign(config, normalizeOAuthState(JSON.parse(JSON.stringify(config))));
assert.equal(provider.authenticate(tokens.access_token).key.id, 'key_test', '持久化后令牌仍可用');

const refreshed = provider.refresh({ client_id: client.id, refresh_token: tokens.refresh_token });
assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
rejects(() => provider.authenticate(tokens.access_token), 'invalid_token');
provider.authenticate(refreshed.access_token);
rejects(() => provider.refresh({ client_id: client.id, refresh_token: tokens.refresh_token }), 'invalid_grant');
rejects(() => provider.authenticate(refreshed.access_token), 'invalid_token');

const reducedStart = authorize();
rejects(() => provider.refresh({ client_id: client.id, refresh_token: reducedStart.refresh_token, scope: 'admin' }), 'invalid_scope');
const reduced = provider.refresh({ client_id: client.id, refresh_token: reducedStart.refresh_token, scope: 'models:read' });
assert.equal(reduced.scope, 'models:read');
assert.equal(reduced.refresh_token, undefined);
rejects(() => provider.authenticate(reduced.access_token, 'models:invoke'), 'insufficient_scope');
assert.equal(provider.publicGrant(provider.authenticate(reduced.access_token).grant).expiresAt, new Date(now + ACCESS_TTL_MS).toISOString());
const otherClient = provider.saveClient({ name: 'Other', sourceKeyId: 'key_test', redirectUris: ['https://other.example.test/callback'] });
const wrongClient = authorize();
rejects(() => provider.refresh({ client_id: otherClient.id, refresh_token: wrongClient.refresh_token }), 'invalid_grant');
provider.revokeToken({ client_id: otherClient.id, token: wrongClient.access_token });
provider.authenticate(wrongClient.access_token);
provider.revokeToken({ client_id: client.id, token: wrongClient.refresh_token });
rejects(() => provider.authenticate(wrongClient.access_token), 'invalid_token');

const sameHost = provider.saveClient({ name: 'Same host', sourceKeyId: 'key_test', redirectUris: ['https://gateway.example.test:8443/callback'] });
rejects(() => consent({ ...parameters, client_id: sameHost.id, redirect_uri: sameHost.redirectUris[0] }), 'invalid_request');
const sameHostDot = provider.saveClient({ name: 'Same host dot', sourceKeyId: 'key_test', redirectUris: ['https://gateway.example.test./callback'] });
rejects(() => consent({ ...parameters, client_id: sameHostDot.id, redirect_uri: sameHostDot.redirectUris[0] }), 'invalid_request');
const storedGrant = config.oauthGrants[0];
for (const changes of [{ scopes: undefined }, { keyAccess: {} }, { subject: { ...storedGrant.subject, credentialVersion: '' } }, { accessExpiresAt: 'invalid date' }, { usedRefreshHashes: ['not-a-hash'] }]) {
  rejects(() => normalizeOAuthState({ oauthGrants: [{ ...storedGrant, ...changes }] }), 'invalid_request');
}
assert.deepEqual(normalizeOAuthState({}), { oauthClients: [], oauthGrants: [] });
rejects(() => normalizeOAuthState({ oauthClients: [config.oauthClients[0], config.oauthClients[0]] }), 'invalid_request');

const saveFailureCode = new URL(approve(consent()).redirect).searchParams.get('code');
const previousGrants = config.oauthGrants;
failSave = true;
assert.throws(() => exchange(saveFailureCode), /disk unavailable/);
assert.equal(config.oauthGrants, previousGrants, '持久化失败不能签发仅在内存有效的令牌');
failSave = false;
const saveFailureToken = exchange(saveFailureCode);
failSave = true;
assert.throws(() => provider.refresh({ client_id: client.id, refresh_token: saveFailureToken.refresh_token }), /disk unavailable/);
provider.authenticate(saveFailureToken.access_token);
assert.throws(() => provider.revokeToken({ client_id: client.id, token: saveFailureToken.access_token }), /disk unavailable/);
provider.authenticate(saveFailureToken.access_token);
assert.throws(() => provider.saveClient({ name: 'unsaved change' }, client.id), /disk unavailable/);
provider.authenticate(saveFailureToken.access_token);
failSave = false;
provider.revokeToken({ client_id: client.id, token: saveFailureToken.access_token });
rejects(() => provider.authenticate(saveFailureToken.access_token), 'invalid_token');

const expires = authorize();
now += ACCESS_TTL_MS + 1;
rejects(() => provider.authenticate(expires.access_token), 'invalid_token');
const expiresRefreshed = provider.refresh({ client_id: client.id, refresh_token: expires.refresh_token });
provider.authenticate(expiresRefreshed.access_token);
now += REFRESH_TTL_MS;
rejects(() => provider.refresh({ client_id: client.id, refresh_token: expiresRefreshed.refresh_token }), 'invalid_grant');

const readOnly = consent({ ...parameters, scope: 'models:read' });
const readOnlyTokens = exchange(new URL(approve(readOnly).redirect).searchParams.get('code'));
assert.equal(readOnlyTokens.refresh_token, undefined);
rejects(() => provider.authenticate(readOnlyTokens.access_token, 'models:invoke'), 'insufficient_scope');
provider.revokeToken({ client_id: client.id, token: readOnlyTokens.access_token });
rejects(() => provider.authenticate(readOnlyTokens.access_token), 'invalid_token');
assert.deepEqual(provider.revokeToken({ client_id: client.id, token: 'unknown' }), {});

config.localApiKeys[0] = { ...config.localApiKeys[0], modelAccessMode: 'custom', allowedGroups: ['gpt'], allowedModels: ['gpt-one'] };
const limited = authorize();
config.localApiKeys[0].allowedModels.push('gpt-two');
assert.deepEqual(provider.authenticate(limited.access_token).key.allowedModels, ['gpt-one'], '来源权限扩大不能扩大已确认的自定义授权');
config.localApiKeys[0].allowedModels = [];
assert.deepEqual(provider.authenticate(limited.access_token).key.allowedModels, [], '来源权限收缩立即生效');
config.localApiKeys[0].enabled = false;
rejects(() => provider.authenticate(limited.access_token), 'invalid_token');
config.localApiKeys[0].enabled = true;
subjectActive = false;
rejects(() => provider.authenticate(limited.access_token), 'invalid_token');
subjectActive = true;
provider.saveClient({ name: 'updated' }, client.id);
rejects(() => provider.authenticate(limited.access_token), 'invalid_token');

const staleConsent = consent();
now += 10 * 60 * 1000 + 1;
rejects(() => approve(staleConsent), 'invalid_request');
const staleCode = new URL(approve(consent()).redirect).searchParams.get('code');
now += 2 * 60 * 1000 + 1;
rejects(() => exchange(staleCode), 'invalid_grant');
const revoked = authorize();
provider.deleteClient(client.id);
rejects(() => provider.authenticate(revoked.access_token), 'invalid_token');

// 首次连接的自动登记：接入方不预登记 Client，由登录账号在确认时选择来源 Key。
config.localApiKeys.push({ id: 'key_second', key: 'secret-second', name: '第二来源', enabled: true, modelAccessMode: 'all' });
const autoRedirect = 'https://client.example.test/auto-callback';
const autoParams = { client_id: 'auto', name: 'Life Dashboard', redirect_uri: autoRedirect, response_type: 'code', state: 'auto-state', code_challenge: challenge, code_challenge_method: 'S256', scope: 'models:read models:invoke offline_access' };
rejects(() => normalizeOAuthClient({ name: '保留字', sourceKeyId: 'key_test', redirectUris: [autoRedirect], id: 'auto' }), 'invalid_request');
rejects(() => consent({ ...autoParams, name: ' ' }), 'invalid_request');
rejects(() => consent({ ...autoParams, code_challenge: 'x'.repeat(42) }), 'invalid_request');
rejects(() => consent({ ...autoParams, redirect_uri: 'https://gateway.example.test/cb' }), 'invalid_request');
rejects(() => consent({ ...autoParams, key_id: 'key_missing' }), 'invalid_request');
config.localApiKeys.forEach((item) => { item.enabled = false; });
rejects(() => consent(autoParams), 'access_denied');
config.localApiKeys.forEach((item) => { item.enabled = true; });
const autoConsent = consent(autoParams);
assert.equal(autoConsent.auto, true);
assert.deepEqual(autoConsent.sourceKeys.map((item) => item.id), ['key_test', 'key_second']);
assert.equal(autoConsent.client.name, 'Life Dashboard');
assert.equal('id' in autoConsent.client, false);
assert.equal(autoConsent.sourceKey.id, 'key_test');
const autoSecond = consent({ ...autoParams, key_id: 'key_second' });
assert.equal(autoSecond.sourceKey.id, 'key_second');
const autoDecide = (details, extra) => provider.decideConsent({ request_id: details.request_id, csrf_token: details.csrf_token, approve: true, ...extra }, 'session-a', subject, issuer);
rejects(() => provider.decideConsent({ request_id: autoConsent.request_id, csrf_token: autoConsent.csrf_token, approve: true }, 'session-a', subject, issuer), 'invalid_request');
rejects(() => autoDecide(autoConsent, { source_key_id: 'key_missing' }), 'invalid_request');
const autoCode = new URL(autoDecide(autoConsent, { source_key_id: 'key_second' }).redirect).searchParams.get('code');
const created = config.oauthClients.find((item) => item.redirectUris.includes(autoRedirect));
assert.ok(created, '确认授权后应完成自动登记');
assert.equal(created.name, 'Life Dashboard');
assert.equal(created.sourceKeyId, 'key_second');
rejects(() => provider.exchangeCode({ client_id: 'auto', code: autoCode, redirect_uri: autoRedirect + '/other', code_verifier: verifier }, issuer), 'invalid_grant');
rejects(() => provider.exchangeCode({ client_id: 'auto', code: autoCode, redirect_uri: autoRedirect, code_verifier: 'b'.repeat(43) }, issuer), 'invalid_grant');
const autoTokens = provider.exchangeCode({ client_id: 'auto', code: autoCode, redirect_uri: autoRedirect, code_verifier: verifier }, issuer);
assert.equal(autoTokens.client_id, created.id);
provider.authenticate(autoTokens.access_token);
const autoRefreshed = provider.refresh({ client_id: created.id, refresh_token: autoTokens.refresh_token });
provider.authenticate(autoRefreshed.access_token);
rejects(() => provider.authenticate(autoTokens.access_token), 'invalid_token');
const autoAgain = consent(autoParams);
const againCode = new URL(autoDecide(autoAgain, { source_key_id: 'key_second' }).redirect).searchParams.get('code');
const againTokens = provider.exchangeCode({ client_id: 'auto', code: againCode, redirect_uri: autoRedirect, code_verifier: verifier }, issuer);
assert.equal(againTokens.client_id, created.id, '相同回调应复用已登记应用');
assert.equal(config.oauthClients.filter((item) => item.redirectUris.includes(autoRedirect)).length, 1, '不能重复登记');
rejects(() => provider.authenticate(autoRefreshed.access_token), 'invalid_token', '复用登记应使该应用的旧令牌失效');
assert.equal(provider.publicGrant(config.oauthGrants.find((item) => item.clientId === created.id)).sourceKey.name, '第二来源');
provider.revokeToken({ client_id: created.id, token: againTokens.access_token });
rejects(() => provider.authenticate(againTokens.access_token), 'invalid_token');
assert.ok(saved > 0);
console.log('OAuth authorization unit tests passed');