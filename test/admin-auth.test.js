const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-admin-auth-unit-'));
const originalDataDirectory = process.env.SAKURA_AI_GATEWAY_DATA_DIR;
process.env.SAKURA_AI_GATEWAY_DATA_DIR = directory;
const {
  AdminAuth,
  isLoopbackAddress,
  normalizeAddress,
  requestSource,
  trustedProxySet
} = require('../src/admin-auth');
const { hashPassword } = require('../src/admin-users');

function request(remoteAddress, headers = {}) {
  return { socket: { remoteAddress }, headers };
}

function makeAuth(adminAuth) {
  return new AdminAuth({ env: {}, log: () => {}, getAdminAuth: () => adminAuth, fetch: async () => { throw new Error('network disabled'); } });
}

assert.equal(normalizeAddress('::ffff:127.0.0.1'), '127.0.0.1');
assert.equal(normalizeAddress('::1%0'), '::1');
assert.equal(isLoopbackAddress('127.0.0.25'), true);
assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
assert.equal(isLoopbackAddress('192.168.1.10'), false);

assert.deepEqual(requestSource(request('127.0.0.1')), {
  address: '127.0.0.1',
  socketAddress: '127.0.0.1',
  viaTrustedProxy: false,
  untrustedForwarding: false
});

const spoofed = requestSource(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }));
assert.equal(spoofed.address, '');
assert.equal(spoofed.untrustedForwarding, true);
assert.equal(isLoopbackAddress(spoofed.address), false);

const trusted = trustedProxySet('127.0.0.1, ::1');
const remote = requestSource(request('::ffff:127.0.0.1', { 'x-forwarded-for': '203.0.113.25' }), trusted);
assert.equal(remote.address, '203.0.113.25');
assert.equal(remote.viaTrustedProxy, true);
assert.equal(isLoopbackAddress(remote.address), false);

const proxiedLocal = requestSource(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.8' }), trusted);
assert.equal(proxiedLocal.address, '127.0.0.8');
assert.equal(isLoopbackAddress(proxiedLocal.address), true);

const chain = requestSource(request('127.0.0.1', { 'x-forwarded-for': '198.51.100.20, 127.0.0.1' }), trusted);
assert.equal(chain.address, '198.51.100.20');

const diagnosticSource = requestSource(request('172.22.0.1', { 'x-forwarded-for': '203.0.113.10' }), trustedProxySet('127.0.0.1'));
assert.equal(diagnosticSource.socketAddress, '172.22.0.1');
assert.equal(diagnosticSource.viaTrustedProxy, false);

console.log('admin auth tests passed');

// ---- 本地账号密码认证 ----
async function passwordAuthTests() {
const password = 'correct-horse-battery';
const users = [
  { id: 'admin_a', username: 'alice', passwordHash: hashPassword(password), enabled: true },
  { id: 'admin_b', username: 'bob', passwordHash: hashPassword('disabled-pass'), enabled: false }
];
const remoteReq = request('203.0.113.42', { host: 'gateway.example.test' });

const noAccounts = makeAuth({ users });
assert.equal(noAccounts.isPasswordConfigured(), true, '存在启用账号即密码可用');
assert.equal(noAccounts.remoteConfigured(), true, '有本地账号时远程登录可用');
assert.equal(noAccounts.remoteConfigurationError(), '');

const passwordMode = makeAuth({ users });
assert.equal(passwordMode.isPasswordConfigured(), true);
assert.equal(passwordMode.remoteConfigured(), true);
assert.equal(passwordMode.remoteConfigurationError(), '');

const disabledOnly = makeAuth({ users: users.filter((item) => !item.enabled) });
assert.equal(disabledOnly.isPasswordConfigured(), false, '全部停用账号时未配置');
assert.ok(disabledOnly.remoteConfigurationError().includes('还没有可用的本地管理员账号'));

// 没有可用账号时拒绝密码登录
await assert.rejects(() => makeAuth({ users: [] }).loginWithPassword(remoteReq, { username: 'alice', password }), /还没有可用的本地管理员账号/);

// 正确凭据建立会话
const login = await passwordMode.loginWithPassword(remoteReq, { username: 'alice', password });
assert.equal(login.user.username, 'alice');
assert.match(login.cookie, /sakura_ai_gateway_admin_session=/);
assert.match(login.cookie, /HttpOnly/);
const sessionCookie = login.cookie.split(';')[0].split('=').slice(1).join('=');
// 无状态签名令牌：能被 sessionForRequest 重新解析
const directAccess = passwordMode.sessionForRequest(request('203.0.113.42', { host: 'gateway.example.test', cookie: `sakura_ai_gateway_admin_session=${sessionCookie}` }));
assert.ok(directAccess, '签名会话令牌应能通过 sessionForRequest 校验');
assert.equal(directAccess.user.username, 'alice');
const shortAuth = new AdminAuth({ env: {}, sessionTtlSeconds: 600, getAdminAuth: () => ({ users }) });
const shortLogin = await shortAuth.loginWithPassword(remoteReq, { username: 'alice', password });
const shortToken = shortLogin.cookie.split(';')[0].split('=')[1];
const claims = JSON.parse(Buffer.from(shortToken.split('.')[0], 'base64url').toString('utf8'));
assert.equal(claims.exp - claims.iat, 600, '签名令牌内部过期时间必须使用配置的 TTL');
assert.match(shortLogin.cookie, /Max-Age=600(?:;|$)/);
const now = Date.now;
try {
  Date.now = () => (claims.exp + 1) * 1000;
  assert.equal(shortAuth.sessionForRequest(request('203.0.113.42', { cookie: shortLogin.cookie.split(';')[0] })), null);
} finally { Date.now = now; }

// 错误密码失败、停用账号不能登录
await assert.rejects(() => passwordMode.loginWithPassword(remoteReq, { username: 'alice', password: 'wrong' }), /用户名或密码错误/);
await assert.rejects(() => passwordMode.loginWithPassword(remoteReq, { username: 'bob', password: 'disabled-pass' }), /用户名或密码错误/);

// 同源绑定：authenticate 返回的会话带 originHost
const access = passwordMode.authenticate(request('203.0.113.42', { host: 'gateway.example.test', cookie: `sakura_ai_gateway_admin_session=${sessionCookie}` }));
assert.equal(access.ok, true);
assert.equal(access.mode, 'password');
assert.equal(access.user.username, 'alice');

// 回环仍然免认证
assert.equal(passwordMode.authenticate(request('127.0.0.1')).mode, 'local');

// requireLocalLogin：开启后本机回环也要求登录（两种登录方式任一可用即生效）
const requireLocal = makeAuth({ requireLocalLogin: true, users });
assert.equal(requireLocal.requireLocalLogin(), true);
const loopbackAnonymous = requireLocal.authenticate(request('127.0.0.1'));
assert.equal(loopbackAnonymous.ok, false, '开启后回环匿名访问不再放行');
assert.equal(loopbackAnonymous.localLoginRequired, true);
const localLogin = await requireLocal.loginWithPassword(request('127.0.0.1', { host: '127.0.0.1:8787' }), { username: 'alice', password });
const localCookie = localLogin.cookie.split(';')[0].split('=').slice(1).join('=');
const localAccess = requireLocal.authenticate(request('127.0.0.1', { host: '127.0.0.1:8787', cookie: `sakura_ai_gateway_admin_session=${localCookie}` }));
assert.equal(localAccess.ok, true, '回环携带有效会话应当放行');
assert.equal(localAccess.mode, 'password');

// 没有任何可用登录方式时开启也不生效（保留创建第一个账号的入口）
assert.equal(makeAuth({ requireLocalLogin: true, users: [] }).authenticate(request('127.0.0.1')).mode, 'local');
// 未开启时回环免认证
assert.equal(makeAuth({ requireLocalLogin: false, users }).authenticate(request('127.0.0.1')).mode, 'local');

// 摘要不含哈希
const summary = passwordMode.localUsersSummary();
assert.equal(summary.users.length, 2);
assert.equal(summary.users[0].username, 'alice');
assert.ok(!JSON.stringify(summary).includes('scrypt$'));

// 连续失败 5 次后锁定，之后 60 秒内的成功登录也被拒绝
const lockoutAuth = makeAuth({ users });
for (let index = 0; index < 4; index += 1) {
  // eslint-disable-next-line no-await-in-loop
  await assert.rejects(() => lockoutAuth.loginWithPassword(remoteReq, { username: 'alice', password: 'bad' }));
}
let fifth;
try {
  await lockoutAuth.loginWithPassword(remoteReq, { username: 'alice', password: 'bad' });
  fifth = null;
} catch (error) { fifth = error; }
assert.ok(fifth, '第 5 次失败应返回错误');
const locked = await lockoutAuth.loginWithPassword(remoteReq, { username: 'alice', password }).catch((error) => error);
assert.equal(locked.statusCode, 429, '锁定期间即使密码正确也返回 429');

console.log('admin auth password tests passed');
}

passwordAuthTests().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalDataDirectory === undefined) delete process.env.SAKURA_AI_GATEWAY_DATA_DIR;
  else process.env.SAKURA_AI_GATEWAY_DATA_DIR = originalDataDirectory;
});