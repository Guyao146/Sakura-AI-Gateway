// 真实 Chrome 授权回归，沿用项目现有 CDP + Node 内置 WebSocket，不安装依赖。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = async function oauthBrowser(base, { username, password, sourceKeyId }) {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert(fs.existsSync(chrome), '设置 CHROME_PATH 为本机 Chrome 路径');
  assert.equal(typeof WebSocket, 'function', '浏览器测试需要 Node 22+ 内置 WebSocket');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-oauth-browser-'));
  let browser;
  let socket;
  const pending = new Map();
  const callbacks = [];
  const callbackServer = http.createServer((req, res) => {
    if (req.url.startsWith('/callback')) callbacks.push({ url: req.url, referer: req.headers.referer, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><html><head><title>Test callback</title></head><body>OAuth callback received</body></html>');
  });
  try {
    callbackServer.listen(0, '127.0.0.1');
    await once(callbackServer, 'listening');
    // 不同主机名避免测试用的网关 Cookie 随回调发送给应用（Cookie 不隔离端口）。
    const redirectUri = `http://localhost:${callbackServer.address().port}/callback?source=browser`;
    browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i += 1) await pause(50);
    assert(fs.existsSync(portFile), 'Chrome 启动超时');
    const debugPort = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await once(socket, 'open');
    const exceptions = [];
    let serial = 0;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      const task = pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i += 1) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      const page = await evaluate('({url: location.href, ready: document.readyState, text: document.body?.innerText.slice(0, 2500)})');
      throw new Error(`浏览器等待超时：${expression}\n${JSON.stringify({ page, exceptions }, null, 2)}`);
    };
    const navigate = (url) => cdp('Page.navigate', { url });
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth';
    const viewport = (width) => cdp('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: width < 700 });
    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await viewport(1440);
    await navigate(base);
    await waitFor('Boolean(document.querySelector("#dashboard:not(.hidden)"))');
    await click('[data-tab="keys"]');
    await click('#addOAuthClientButton');
    await waitFor('document.querySelector("#oauthClientDialog").open');
    const name = 'Browser <img src=x onerror=alert(1)>';
    await evaluate(`document.querySelector('#oauthClientName').value = ${JSON.stringify(name)};
      document.querySelector('#oauthClientSourceKey').value = ${JSON.stringify(sourceKeyId)};
      document.querySelector('#oauthClientRedirectUris').value = 'https://invalid.example/*';
      document.querySelector('#oauthClientForm').requestSubmit();`);
    await waitFor('Boolean(document.querySelector("#oauthClientFormMessage").textContent)');
    assert.equal(await evaluate('document.querySelector("#oauthClientDialog").open'), true, '非法回调不能保存');
    await evaluate(`document.querySelector('#oauthClientRedirectUris').value = ${JSON.stringify(redirectUri)}; document.querySelector('#oauthClientForm').requestSubmit()`);
    await waitFor('!document.querySelector("#oauthClientDialog").open');
    await waitFor(`document.querySelector('#oauthClientList').textContent.includes(${JSON.stringify(name)})`);
    assert.equal(await evaluate('document.querySelectorAll("#oauthClientList img").length'), 0, '应用名称必须按文本显示');
    const clients = await (await fetch(`${base}/api/admin/oauth-clients`)).json();
    const client = clients.clients.find((item) => item.name === name);
    assert(client, '浏览器登记的应用应已保存');
    for (const width of [390, 320, 1440]) {
      await viewport(width);
      assert.equal(await evaluate(noOverflow), true, `${width}px 应用列表不能横向溢出`);
    }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = new URLSearchParams({ client_id: client.id, response_type: 'code', redirect_uri: redirectUri, scope: 'models:read models:invoke offline_access',
      state: crypto.randomBytes(24).toString('base64url'), code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const authorizeUrl = `${base}/oauth/authorize?${params}`;
    await navigate(authorizeUrl);
    await waitFor('Boolean(document.querySelector("#authorizeLogin:not(.hidden)"))');
    assert.equal(callbacks.length, 0, '登录前不能直接授权');
    await click('#authorizeLogin');
    await waitFor('Boolean(document.querySelector("#passwordLoginForm:not(.hidden)"))');
    assert.equal(await evaluate('new URLSearchParams(location.search).get("returnTo")'), `/oauth/authorize?${params}`);
    assert.deepEqual(await evaluate(`['/\\\\evil.example', '//evil.example', '/a/..//evil.example', '/%2e%2e//evil.example'].map(AuthUtils.safeReturnTo)`), ['/', '/', '/', '/']);
    await evaluate(`document.querySelector('#loginUsername').value = ${JSON.stringify(username)}; document.querySelector('#loginPassword').value = ${JSON.stringify(password)}; document.querySelector('#passwordLoginButton').click()`);
    await waitFor('Boolean(document.querySelector("#authorizeForm:not(.hidden)"))');
    assert.equal(await evaluate('document.querySelector("#authorizeClient").textContent'), name);
    assert.equal(await evaluate('document.querySelector("#authorizeAccount").textContent'), username);
    assert.equal(await evaluate('document.querySelector("#authorizeRedirect").textContent'), redirectUri);
    assert.equal(await evaluate('document.querySelectorAll("#authorizeScopes li").length'), 3);
    assert.equal(await evaluate('document.querySelectorAll("#authorizeClient img").length'), 0);
    assert.equal(callbacks.length, 0, '登录成功后仍必须明确同意');
    for (const width of [390, 320, 1440]) {
      await viewport(width);
      assert.equal(await evaluate(noOverflow), true, `${width}px 授权页不能横向溢出`);
    }
    await click('#denyAuthorization');
    await waitFor('location.hostname === "localhost" && location.pathname === "/callback"');
    const denied = new URL(callbacks[0].url, redirectUri);
    assert.equal(denied.searchParams.get('error'), 'access_denied');
    assert.equal(denied.searchParams.get('state'), params.get('state'));
    assert.equal(denied.searchParams.has('code'), false);
    assert.equal(callbacks[0].referer, undefined);
    assert.equal(callbacks[0].cookie, undefined);
    await navigate(authorizeUrl);
    await waitFor('Boolean(document.querySelector("#authorizeForm:not(.hidden)"))');
    await click('#approveAuthorization');
    await waitFor('location.hostname === "localhost" && location.pathname === "/callback" && location.search.includes("code=")');
    const approved = new URL(callbacks[1].url, redirectUri);
    assert.equal(approved.searchParams.get('state'), params.get('state'));
    assert.equal(approved.searchParams.get('iss'), base);
    assert.equal(callbacks[1].referer, undefined);
    assert.equal(callbacks[1].cookie, undefined);
    const exchange = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.id, redirect_uri: redirectUri, code: approved.searchParams.get('code'), code_verifier: verifier
    }) });
    assert.equal(exchange.status, 200);
    const tokens = await exchange.json();
    const modelRequest = () => fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    assert.equal((await modelRequest()).status, 200);
    await navigate(base);
    await waitFor('Boolean(document.querySelector("#dashboard:not(.hidden)"))');
    await click('[data-tab="keys"]');
    await waitFor(`Boolean([...document.querySelectorAll('#integrationList article')].find(item => item.textContent.includes(${JSON.stringify(name)}) && item.querySelector('[data-action="revoke-integration"]')))`);
    await evaluate('window.confirm = () => true');
    await evaluate(`[...document.querySelectorAll('#integrationList article')].find(item => item.textContent.includes(${JSON.stringify(name)})).querySelector('[data-action="revoke-integration"]').click()`);
    await waitFor(`Boolean([...document.querySelectorAll('#integrationList article')].find(item => item.textContent.includes(${JSON.stringify(name)}) && item.textContent.includes('已取消')))`);
    assert.equal((await modelRequest()).status, 401, '浏览器取消授权必须真的撤销令牌');
    await waitFor(`Boolean(document.querySelector('[data-oauth-action="edit"][data-id="${client.id}"]'))`);
    await click(`[data-oauth-action="edit"][data-id="${client.id}"]`);
    await waitFor('document.querySelector("#oauthClientDialog").open');
    await evaluate(`document.querySelector('#oauthClientName').value = 'Browser updated'; document.querySelector('#oauthClientForm').requestSubmit()`);
    await waitFor('!document.querySelector("#oauthClientDialog").open && document.querySelector("#oauthClientList").textContent.includes("Browser updated")');
    await click(`[data-oauth-action="toggle"][data-id="${client.id}"]`);
    await waitFor(`document.querySelector('[data-oauth-action="toggle"][data-id="${client.id}"]').textContent === '启用'`);
    await click(`[data-oauth-action="delete"][data-id="${client.id}"]`);
    await waitFor(`!document.querySelector('[data-oauth-action="edit"][data-id="${client.id}"]')`);
    assert.deepEqual(exceptions, [], '浏览器不能出现未处理脚本异常');
    console.log('OAuth browser tests passed (application registration, login, consent/denial, callback, revocation, responsive layout)');
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    socket?.close();
    if (browser && browser.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
      } else { const exited = once(browser, 'exit'); browser.kill(); await exited; }
    }
    callbackServer.closeAllConnections?.();
    if (callbackServer.listening) await new Promise((resolve) => callbackServer.close(resolve));
    await pause(300);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
};