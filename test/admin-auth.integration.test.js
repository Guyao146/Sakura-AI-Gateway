const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-admin-auth-'));
const gatewayPort = 27000 + Math.floor(Math.random() * 1000);
const remoteHost = `gateway-${gatewayPort}.example.test`;
const remoteHeaders = { Host: remoteHost, 'X-Forwarded-For': '203.0.113.77' };
const username = 'gateway-admin';
const password = 'correct-horse-battery';

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
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时：${output}`)), 12000);
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

function cookiePair(setCookie, name) {
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  const entry = entries.find((value) => String(value).startsWith(`${name}=`));
  return entry ? String(entry).split(';', 1)[0] : '';
}

function spawnGateway() {
  return spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      HOST: '127.0.0.1',
      SAKURA_AI_GATEWAY_DATA_DIR: dataDirectory,
      TRUSTED_PROXY_ADDRESSES: '127.0.0.1,::1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

async function main() {
  const gateway = spawnGateway();
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${gatewayPort}`;
  try {
    await waitForOutput(gateway, 'Sakura-AI-Gateway 已启动');

    // 远程默认走 OIDC，此时未配置 → 503
    const initialStatus = await request(`${baseUrl}/auth/status`, { headers: remoteHeaders });
    assert.equal(initialStatus.status, 503, initialStatus.raw);
    assert.equal(initialStatus.json.remoteMode, 'oidc');

    // 密码登录端点在 oidc 模式下应拒绝
    const wrongModeLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(wrongModeLogin.status, 409, wrongModeLogin.raw);

    // 本机回环创建管理员账号
    const created = await request(`${baseUrl}/api/admin/admin-auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(created.status, 201, created.raw);
    assert.equal(created.json.user.username, username);
    assert.ok(!JSON.stringify(created.json).includes('passwordHash'), '响应不应包含密码哈希');

    // 用户名冲突
    const duplicate = await request(`${baseUrl}/api/admin/admin-auth/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(duplicate.status, 409, duplicate.raw);

    // 切换到 password 模式
    const switched = await request(`${baseUrl}/api/admin/admin-auth/remote-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteMode: 'password' })
    });
    assert.equal(switched.status, 200, switched.raw);
    assert.equal(switched.json.remoteMode, 'password');

    // 切回 oidc 但未配置应拒绝
    const switchBackEarly = await request(`${baseUrl}/api/admin/admin-auth/remote-mode`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remoteMode: 'oidc' })
    });
    assert.equal(switchBackEarly.status, 400, switchBackEarly.raw);

    // /auth/status 现在应报告 password 模式且已配置
    const readyStatus = await request(`${baseUrl}/auth/status`, { headers: remoteHeaders });
    assert.equal(readyStatus.status, 401, readyStatus.raw);
    assert.equal(readyStatus.json.remoteMode, 'password');
    assert.equal(readyStatus.json.configured, true);

    // 错误密码
    const badLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'wrong-password' })
    });
    assert.equal(badLogin.status, 401, badLogin.raw);
    assert.ok(badLogin.json.error.message.includes('用户名或密码错误'), badLogin.json.error.message);

    // 正确密码
    const goodLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(goodLogin.status, 200, goodLogin.raw);
    const sessionCookie = cookiePair(goodLogin.headers['set-cookie'], 'sakura_ai_gateway_admin_session');
    assert.ok(sessionCookie, '登录应返回会话 Cookie');
    assert.match((Array.isArray(goodLogin.headers['set-cookie']) ? goodLogin.headers['set-cookie'] : []).join('\n'), /HttpOnly/);
    assert.equal(goodLogin.json.user.username, username);

    // 会话可访问管理接口
    const configWithSession = await request(`${baseUrl}/api/admin/config`, {
      headers: { ...remoteHeaders, Cookie: sessionCookie, Origin: `http://${remoteHost}` }
    });
    assert.equal(configWithSession.status, 200, configWithSession.raw);

    // 无 Origin 的非 GET 请求应被拒绝（同源保护）
    const writeWithoutOrigin = await request(`${baseUrl}/api/admin/settings`, {
      method: 'PUT',
      headers: { ...remoteHeaders, Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(writeWithoutOrigin.status, 403, writeWithoutOrigin.raw);

    // 无会话的远程请求仍是 401
    const noSession = await request(`${baseUrl}/api/admin/config`, { headers: remoteHeaders });
    assert.equal(noSession.status, 401, noSession.raw);

    // 登出后回到 401
    const logout = await request(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { ...remoteHeaders, Cookie: sessionCookie, Origin: `http://${remoteHost}` }
    });
    assert.equal(logout.status, 302, logout.raw);
    assert.equal(logout.headers.location, '/auth/login');
    const afterLogout = await request(`${baseUrl}/api/admin/config`, { headers: remoteHeaders });
    assert.equal(afterLogout.status, 401, afterLogout.raw);

    // 密码模式下不能删除最后一个启用账号
    const summary = await request(`${baseUrl}/api/admin/admin-auth`, { headers: { Host: '127.0.0.1:8787' } });
    const userId = summary.json.users[0].id;
    const deleteLast = await request(`${baseUrl}/api/admin/admin-auth/users/${userId}`, {
      method: 'DELETE',
      headers: { Host: '127.0.0.1:8787' }
    });
    assert.equal(deleteLast.status, 400, deleteLast.raw);
    assert.match(deleteLast.json.error.message, /至少保留一个/);

    // 修改密码后旧密码失效、新密码可用
    const rotated = await request(`${baseUrl}/api/admin/admin-auth/users/${userId}`, {
      method: 'PUT',
      headers: { Host: '127.0.0.1:8787', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'rotated-secret-99' })
    });
    assert.equal(rotated.status, 200, rotated.raw);
    const oldLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    assert.equal(oldLogin.status, 401, oldLogin.raw);
    const newLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'rotated-secret-99' })
    });
    assert.equal(newLogin.status, 200, newLogin.raw);

    // 同一来源连续失败 5 次后触发锁定（429）
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // 连续失败计数，忽略返回值
      // eslint-disable-next-line no-await-in-loop
      await request(`${baseUrl}/auth/password/login`, {
        method: 'POST',
        headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'other-user', password: 'whatever12' })
      });
    }
    const lockedLogin = await request(`${baseUrl}/auth/password/login`, {
      method: 'POST',
      headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'rotated-secret-99' })
    });
    assert.equal(lockedLogin.status, 429, `第 6 次登录应被锁定：${lockedLogin.raw}`);

    // 重启后配置仍持久化
    gateway.kill();
    await new Promise((resolve) => gateway.once('exit', resolve));
    const restarted = spawnGateway();
    restarted.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    try {
      await waitForOutput(restarted, '本地账号认证已启用');
      const persistedStatus = await request(`${baseUrl}/auth/status`, { headers: remoteHeaders });
      assert.equal(persistedStatus.json.remoteMode, 'password', '重启后模式应持久化');
      const restartLogin = await request(`${baseUrl}/auth/password/login`, {
        method: 'POST',
        headers: { ...remoteHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password: 'rotated-secret-99' })
      });
      assert.equal(restartLogin.status, 200, '重启后应能用新密码登录');
      console.log('admin-auth 集成测试全部通过');
    } finally {
      restarted.kill();
    }
  } finally {
    gateway.kill();
    if (stderr) console.error(stderr);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

