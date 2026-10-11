const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-auth-'));
const gatewayPort = 24000 + Math.floor(Math.random() * 1000);
const clientId = 'sakura-ai-gateway-test';
const clientSecret = 'test-client-secret';
const remoteHeaders = { Host: 'gateway.example.test', 'X-Forwarded-For': '203.0.113.42' };
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), use: 'sig', alg: 'RS256', kid: 'auth-test-key' };

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* plain-text response */ }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
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
  });
}

function signIdToken(issuer, nonce) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: issuer,
    sub: 'authentik-user-1',
    aud: clientId,
    exp: now + 3600,
    iat: now,
    nonce,
    preferred_username: 'gateway-admin',
    name: 'Gateway Admin',
    email: 'admin@example.test'
  })).toString('base64url');
  const data = `${header}.${payload}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function cookiePair(setCookie, name) {
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  const entry = entries.find((value) => String(value).startsWith(`${name}=`));
  return entry ? String(entry).split(';', 1)[0] : '';
}

async function main() {
  let expectedNonce = '';
  let expectedChallenge = '';
  let tokenRequests = 0;
  let discoveryRequests = 0;
  let discoveryAvailable = false;
  const oidc = http.createServer(async (req, res) => {
    const issuer = `http://127.0.0.1:${oidc.address().port}/application/o/gateway`;
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/application/o/gateway/.well-known/openid-configuration') {
      discoveryRequests += 1;
      if (!discoveryAvailable) {
        json(503, { error: 'temporarily_unavailable' });
        return;
      }
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        end_session_endpoint: `${issuer}/end-session`,
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        id_token_signing_alg_values_supported: ['RS256']
      });
      return;
    }
    if (req.url === '/application/o/gateway/jwks') {
      json(200, { keys: [publicJwk] });
      return;
    }
    if (req.url === '/application/o/gateway/token' && req.method === 'POST') {
      tokenRequests += 1;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const expectedBasic = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      assert.equal(req.headers.authorization, expectedBasic);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'valid-code');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(
        crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
        expectedChallenge,
        'PKCE verifier 必须匹配登录请求的 challenge'
      );
      json(200, { token_type: 'Bearer', access_token: 'test-access-token', id_token: signIdToken(issuer, expectedNonce), expires_in: 3600 });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise((resolve) => oidc.listen(0, '127.0.0.1', resolve));
  const oidcPort = oidc.address().port;
  const issuer = `http://127.0.0.1:${oidcPort}/application/o/gateway`;
  const redirectUri = `http://gateway.example.test/auth/oidc/callback`;
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      HOST: '127.0.0.1',
      SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory,
      AUTHENTIK_ISSUER_URL: issuer,
      AUTHENTIK_CLIENT_ID: clientId,
      AUTHENTIK_CLIENT_SECRET: clientSecret,
      AUTHENTIK_REDIRECT_URI: redirectUri,
      AUTHENTIK_COOKIE_SECURE: 'false',
      TRUSTED_PROXY_ADDRESSES: '127.0.0.1,::1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  try {
    await waitForOutput(gateway, '远程管理访问：Authentik OIDC 已启用');
    const storedConfig = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));

    const localStatus = await request(`${baseUrl}/auth/status`);
    assert.equal(localStatus.status, 200, localStatus.raw);
    assert.equal(localStatus.json.mode, 'local');
    assert.equal((await request(`${baseUrl}/api/admin/config`)).status, 200, '本机管理 API 应免认证');
    assert.equal((await request(`${baseUrl}/api/admin/config`, { headers: { Host: 'attacker.example' } })).status, 403, '本机免认证必须阻止 DNS Rebinding Host');
    assert.equal((await request(`${baseUrl}/api/admin/config`, { headers: { Origin: 'https://attacker.example' } })).status, 403, '本机免认证必须阻止跨站 Origin');

    const remoteStatus = await request(`${baseUrl}/auth/status`, { headers: remoteHeaders });
    assert.equal(remoteStatus.status, 401, remoteStatus.raw);
    assert.equal(remoteStatus.json.authenticated, false);
    const remoteWithLegacyToken = await request(`${baseUrl}/api/admin/config`, {
      headers: { ...remoteHeaders, 'X-Admin-Token': storedConfig.adminToken }
    });
    assert.equal(remoteWithLegacyToken.status, 401, '远程请求不能用旧管理员 Token 绕过 Authentik');

    const remotePage = await request(`${baseUrl}/`, { headers: remoteHeaders });
    assert.equal(remotePage.status, 302);
    assert.match(remotePage.headers.location, /^\/auth\/login\?/);
    assert.equal(discoveryRequests, 0, '打开登录页不应依赖 Authentik 响应');

    const loginPage = await request(`${baseUrl}${remotePage.headers.location}`, { headers: remoteHeaders });
    assert.equal(loginPage.status, 200, loginPage.raw);
    assert.match(loginPage.raw, /使用外部 OIDC 提供商登录/);
    assert.equal(discoveryRequests, 0, '渲染登录页不应访问 Authentik discovery');

    const unavailableLogin = await request(`${baseUrl}/auth/oidc/login?returnTo=%2F`, { headers: remoteHeaders });
    assert.equal(unavailableLogin.status, 302, unavailableLogin.raw);
    assert.match(unavailableLogin.headers.location, /^\/auth\/login\?.*error=/);
    assert.equal(discoveryRequests, 1);
    const unavailablePage = await request(`${baseUrl}${unavailableLogin.headers.location}`, { headers: remoteHeaders });
    assert.equal(unavailablePage.status, 200, unavailablePage.raw);
    assert.match(unavailablePage.raw, /使用外部 OIDC 提供商登录/);

    discoveryAvailable = true;
    const login = await request(`${baseUrl}/auth/oidc/login?returnTo=%2F`, { headers: remoteHeaders });
    assert.equal(login.status, 302, login.raw);
    assert.equal(discoveryRequests, 2);
    const authorizationUrl = new URL(login.headers.location);
    assert.equal(authorizationUrl.origin, `http://127.0.0.1:${oidcPort}`);
    assert.equal(authorizationUrl.searchParams.get('client_id'), clientId);
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUri);
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    expectedNonce = authorizationUrl.searchParams.get('nonce');
    expectedChallenge = authorizationUrl.searchParams.get('code_challenge');
    const state = authorizationUrl.searchParams.get('state');
    const transactionCookie = cookiePair(login.headers['set-cookie'], 'sakura_ai_gateway_oidc_state');
    assert.ok(state && expectedNonce && expectedChallenge && transactionCookie);

    const badCallback = await request(`${baseUrl}/auth/oidc/callback?code=valid-code&state=wrong-state`, {
      headers: { ...remoteHeaders, Cookie: transactionCookie }
    });
    assert.equal(badCallback.status, 401);
    assert.equal(tokenRequests, 0, 'state 校验失败时不能交换 Token');

    const callback = await request(`${baseUrl}/auth/oidc/callback?code=valid-code&state=${encodeURIComponent(state)}`, {
      headers: { ...remoteHeaders, Cookie: transactionCookie }
    });
    assert.equal(callback.status, 302, `${callback.raw}\n${stderr}`);
    assert.equal(callback.headers.location, '/');
    assert.equal(tokenRequests, 1);
    const sessionCookie = cookiePair(callback.headers['set-cookie'], 'sakura_ai_gateway_admin_session');
    assert.ok(sessionCookie, '回调应建立 HttpOnly 管理会话');
    assert.match((Array.isArray(callback.headers['set-cookie']) ? callback.headers['set-cookie'] : []).join('\n'), /HttpOnly/);

    const authenticatedStatus = await request(`${baseUrl}/auth/status`, {
      headers: { ...remoteHeaders, Cookie: sessionCookie }
    });
    assert.equal(authenticatedStatus.status, 200, authenticatedStatus.raw);
    assert.equal(authenticatedStatus.json.mode, 'oidc');
    assert.equal(authenticatedStatus.json.user.username, 'gateway-admin');
    const authenticatedConfig = await request(`${baseUrl}/api/admin/config`, {
      headers: { ...remoteHeaders, Cookie: sessionCookie }
    });
    assert.equal(authenticatedConfig.status, 200, authenticatedConfig.raw);
    assert.equal(authenticatedConfig.json.localApiKeys[0].key, storedConfig.localApiKeys[0].key, 'Authentik 管理会话应能查看完整本地 Key');
    const remoteWriteWithoutOrigin = await request(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { ...remoteHeaders, Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstreamTimeoutMs: 600000 })
    });
    assert.equal(remoteWriteWithoutOrigin.status, 403, '远程会话写操作必须包含同源 Origin');
    const remoteWrite = await request(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { ...remoteHeaders, Cookie: sessionCookie, Origin: 'http://gateway.example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ upstreamTimeoutMs: 600000 })
    });
    assert.equal(remoteWrite.status, 200, remoteWrite.raw);

    const remoteModelsWithoutKey = await request(`${baseUrl}/v1/models`, { headers: remoteHeaders });
    assert.equal(remoteModelsWithoutKey.status, 401, '模型 API 仍应要求本地 API Key');
    const remoteModelsWithKey = await request(`${baseUrl}/v1/models`, {
      headers: { ...remoteHeaders, Authorization: `Bearer ${storedConfig.localApiKeys[0].key}` }
    });
    assert.equal(remoteModelsWithKey.status, 200, remoteModelsWithKey.raw);

    const logout = await request(`${baseUrl}/auth/logout`, {
      headers: { ...remoteHeaders, Cookie: sessionCookie }
    });
    assert.equal(logout.status, 302);
    assert.match(logout.headers.location, /\/end-session\?/);
    assert.equal((await request(`${baseUrl}/api/admin/config`, { headers: { ...remoteHeaders, Cookie: sessionCookie } })).status, 401);
    console.log('auth integration tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    await new Promise((resolve) => oidc.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});