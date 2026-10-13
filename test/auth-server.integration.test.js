// 可选真实 OIDC 联调：SAKURA_AUTH_SERVER_SOURCE 指向 Sakura-Auth-Server 源码。
// 只读外部源码；两个服务均绑定回环地址，数据库、账号、客户端和 Cookie 全部临时创建。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');

class CookieJar {
  constructor() { this.cookies = new Map(); }
  update(response) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(';')[0];
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      const content = pair.slice(separator + 1);
      if (content) this.cookies.set(name, content);
      else this.cookies.delete(name);
    }
  }
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}

async function main() {
  assert.ok(process.env.SAKURA_AUTH_SERVER_SOURCE, '请将 SAKURA_AUTH_SERVER_SOURCE 设置为 Sakura-Auth-Server 源码的绝对路径');
  const authRoot = path.resolve(process.env.SAKURA_AUTH_SERVER_SOURCE);
  assert.equal(JSON.parse(fs.readFileSync(path.join(authRoot, 'package.json'), 'utf8')).name, 'sakura-auth-server');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-real-auth-'));
  const gatewayData = path.join(temporary, 'gateway');
  const authData = path.join(temporary, 'auth');
  const secret = crypto.randomBytes(32).toString('hex');
  const password = crypto.randomBytes(24).toString('base64url');
  let gateway;
  let authServer;
  let output = '';
  const spawnService = (args, cwd, env) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    return child;
  };
  const stop = async (child) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  };
  const waitFor = async (url, child) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const ready = await fetch(url, { signal: AbortSignal.timeout(500), redirect: 'manual' }).then((result) => result.ok, () => false);
      if (ready) return;
      assert.equal(child.exitCode, null, `Service exited: ${output.slice(-3000)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Service startup timed out: ${url}`);
  };
  const request = async (url, { jar, form, body, headers = {}, method = form || body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { ...(jar ? { Cookie: jar.header() } : {}),
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(form ? { body: new URLSearchParams(form).toString() } : body ? { body: JSON.stringify(body) } : {}) });
    if (jar) jar.update(response);
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, headers: response.headers, text, json };
  };
  const checked = (result, status = 200) => { assert.equal(result.status, status, result.text); return result; };
  const hiddenFields = (text) => Object.fromEntries([...text.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map((match) => [match[1], match[2].replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')]));
  try {
    const reservations = [http.createServer(), http.createServer()];
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
    const [authPort, gatewayPort] = reservations.map((server) => server.address().port);
    await Promise.all(reservations.map((server) => new Promise((resolve) => server.close(resolve))));
    const authBase = `http://127.0.0.1:${authPort}`;
    const gatewayBase = `http://127.0.0.1:${gatewayPort}`;
    const redirectUri = `${gatewayBase}/auth/oidc/callback`;
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(AUTHENTIK_|ADMIN_|TLS_|SMTP_)/.test(name)) delete env[name];
    }
    const authEnv = { ...env, PORT: String(authPort), BASE_URL: authBase, DATA_DIR: authData };
    const moduleUrl = (relative) => JSON.stringify(pathToFileURL(path.join(authRoot, relative)).href);
    const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { initDb } from ${moduleUrl('src/core/db.js')};
      import { initKeys } from ${moduleUrl('src/core/keys.js')};
      import { hashPassword } from ${moduleUrl('src/core/password.js')};
      import * as users from ${moduleUrl('src/models/users.js')};
      import * as clients from ${moduleUrl('src/models/clients.js')};
      import * as settings from ${moduleUrl('src/models/settings.js')};
      const db = initDb();
      initKeys();
      settings.setSetting('setup_done', '1');
      settings.setSetting('issuer', process.env.BASE_URL);
      settings.setSetting('site_name', 'Gateway isolated OIDC test');
      const user = users.create({ username: 'gateway-oidc-test', passwordHash: await hashPassword(process.env.TEST_PASSWORD),
        name: 'Gateway OIDC Test', email: 'gateway@example.test', isAdmin: true });
      const client = clients.create({ name: 'Isolated Gateway', redirectUris: [process.env.TEST_REDIRECT_URI],
        scopes: 'openid profile email', isPublic: false, pkceRequired: true, requireConsent: true,
        secretHash: await hashPassword(process.env.TEST_CLIENT_SECRET) });
      console.log('FIXTURE:' + JSON.stringify({ clientId: client.client_id, userId: user.id }));
      db.close();
    `], { cwd: authRoot, env: { ...authEnv, TEST_PASSWORD: password, TEST_CLIENT_SECRET: secret, TEST_REDIRECT_URI: redirectUri }, encoding: 'utf8', timeout: 15000 });
    assert.equal(seed.status, 0, seed.stderr || seed.error?.message);
    const fixture = JSON.parse(seed.stdout.split(/\r?\n/).find((line) => line.startsWith('FIXTURE:')).slice(8));
    // Auth-Server 入口默认监听所有地址；仅测试进程覆写 listen，不改外部项目源码或防火墙。
    authServer = spawnService(['-e', `const http = require('node:http');
      const listen = http.Server.prototype.listen;
      http.Server.prototype.listen = function(port, callback) { return listen.call(this, port, '127.0.0.1', callback); };
      import(${moduleUrl('server.js')}).catch((error) => { console.error(error); process.exitCode = 1; });`], authRoot, authEnv);
    await waitFor(`${authBase}/healthz`, authServer);
    const discovery = checked(await request(`${authBase}/.well-known/openid-configuration`)).json;
    assert.equal(discovery.issuer, authBase);
    assert.ok(discovery.jwks_uri);
    assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
    const gatewayEnv = { ...env, SAKURA_AI_GATEWAY_DATA_DIR: gatewayData, SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1',
      SAKURA_AI_GATEWAY_FORCE_PORT: String(gatewayPort), AUTHENTIK_ISSUER_URL: authBase,
      AUTHENTIK_CLIENT_ID: fixture.clientId, AUTHENTIK_CLIENT_SECRET: secret, AUTHENTIK_REDIRECT_URI: redirectUri,
      AUTHENTIK_COOKIE_SECURE: 'false', AUTHENTIK_SESSION_TTL_SECONDS: '600' };
    const startGateway = async () => {
      gateway = spawnService([path.join(root, 'src', 'server.js')], root, gatewayEnv);
      await waitFor(`${gatewayBase}/health`, gateway);
    };
    await startGateway();
    checked(await request(`${gatewayBase}/api/admin/admin-auth/users`, { body: { username: 'gateway-local-test', password } }), 201);
    checked(await request(`${gatewayBase}/api/admin/admin-auth/remote-mode`, { method: 'PUT', body: { requireLocalLogin: true } }));
    const status = checked(await request(`${gatewayBase}/auth/status`), 401).json;
    assert.equal(status.oidcConfigured, true);
    assert.equal(status.passwordConfigured, true);
    checked(await request(`${gatewayBase}/api/admin/config`), 401);
    const passwordJar = new CookieJar();
    checked(await request(`${gatewayBase}/auth/password/login`, { jar: passwordJar, body: { username: 'gateway-local-test', password } }));
    const accountStatus = (jar) => request(`${gatewayBase}/auth/status?account=1`, { jar });
    assert.equal(checked(await accountStatus(passwordJar)).json.mode, 'password');

    const gatewayJar = new CookieJar();
    const authJar = new CookieJar();
    const start = checked(await request(`${gatewayBase}/auth/oidc/login?account=1&returnTo=%2F`, { jar: gatewayJar }), 302);
    const authorizeUrl = new URL(start.headers.get('location'));
    assert.equal(authorizeUrl.origin, authBase);
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizeUrl.searchParams.get('nonce'));
    const toLogin = checked(await request(authorizeUrl.href, { jar: authJar }), 302);
    const loginPage = checked(await request(new URL(toLogin.headers.get('location'), authBase).href, { jar: authJar }));
    const loginForm = hiddenFields(loginPage.text);
    assert.ok(loginForm._csrf);
    const login = checked(await request(`${authBase}/login`, { jar: authJar,
      form: { ...loginForm, username: 'gateway-oidc-test', password, next: authorizeUrl.pathname + authorizeUrl.search } }), 302);
    const consentPage = checked(await request(new URL(login.headers.get('location'), authBase).href, { jar: authJar }));
    const consent = hiddenFields(consentPage.text);
    assert.ok(consent._csrf);
    const approved = checked(await request(`${authBase}/authorize`, { jar: authJar, form: { ...consent, decision: 'approve', remember: 'on' } }), 302);
    const callbackUrl = new URL(approved.headers.get('location'));
    assert.equal(callbackUrl.origin + callbackUrl.pathname, redirectUri);
    assert.equal(callbackUrl.searchParams.get('state'), authorizeUrl.searchParams.get('state'));
    assert.ok(callbackUrl.searchParams.get('code'));
    const callback = checked(await request(callbackUrl.href, { jar: gatewayJar }), 302);
    assert.equal(callback.headers.get('location'), '/');
    const oidcStatus = checked(await accountStatus(gatewayJar)).json;
    assert.equal(oidcStatus.mode, 'oidc');
    assert.equal(oidcStatus.user.sub, fixture.userId);
    assert.equal(oidcStatus.user.username, 'gateway-oidc-test');
    checked(await request(`${gatewayBase}/api/admin/config`, { jar: gatewayJar, headers: { Origin: gatewayBase } }));
    const sessionToken = gatewayJar.cookies.get('sakura_ai_gateway_admin_session');
    const claims = JSON.parse(Buffer.from(sessionToken.split('.')[0], 'base64url').toString('utf8'));
    assert.equal(claims.exp - claims.iat, 600);
    checked(await request(callbackUrl.href, { jar: gatewayJar }), 401);
    console.log('Real Sakura-Auth-Server login passed (PKCE, discovery/JWKS, userinfo, concurrent password login)');

    await stop(gateway);
    await startGateway();
    assert.equal(checked(await accountStatus(gatewayJar)).json.mode, 'oidc');
    assert.equal(checked(await accountStatus(passwordJar)).json.mode, 'password');
    const replayJar = new CookieJar();
    replayJar.cookies.set('sakura_ai_gateway_admin_session', sessionToken);
    checked(await request(`${gatewayBase}/auth/logout`, { jar: gatewayJar, method: 'POST', headers: { Origin: gatewayBase } }), 302);
    checked(await accountStatus(replayJar), 401);
    checked(await request(`${authBase}/apps`, { jar: authJar }));
    await stop(gateway);
    await startGateway();
    checked(await accountStatus(replayJar), 401);
    checked(await accountStatus(passwordJar));
    assert.equal(fs.readFileSync(path.join(gatewayData, 'config.json'), 'utf8').includes(secret), false);
    console.log('Real Auth-Server integration passed (existing cookies survive restart; logout revocation survives restart; IdP session stays local)');
  } finally {
    await Promise.all([stop(gateway), stop(authServer)]);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });