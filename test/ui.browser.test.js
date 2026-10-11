// Optional Chrome regression: npm run test:ui (Node 22+, CHROME_PATH if needed).
// Uses temporary data only; never connects to a real upstream.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const root = path.join(__dirname, '..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  assert(fs.existsSync(chrome), '设置 CHROME_PATH 为本机 Chrome 路径');
  assert.equal(typeof WebSocket, 'function', 'UI 测试需要 Node 22+ 内置 WebSocket');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-ui-'));
  const profile = path.join(temporary, 'chrome');
  let gateway;
  let browser;
  let socket;
  const pending = new Map();
  try {
    const reservation = http.createServer().listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    gateway = spawn(process.execPath, [path.join(root, 'src', 'server.js')], {
      cwd: root,
      env: { ...process.env, SAKURA_AI_GATEWAY_DATA_DIR: path.join(temporary, 'data'), SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1', SAKURA_AI_GATEWAY_FORCE_PORT: String(port), ADMIN_REMOTE_MODE: 'oidc' },
      stdio: 'ignore'
    });
    let ready = false;
    for (let i = 0; i < 200; i += 1) {
      ready = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false);
      if (ready) break;
      assert.equal(gateway.exitCode, null, '临时网关意外退出');
      await pause(50);
    }
    assert(ready, '临时网关启动超时');
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
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
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
      for (let i = 0; i < 150; i += 1) {
        if (await evaluate(expression)) return;
        await pause(50);
      }
      throw new Error(`等待超时: ${expression}`);
    };
    const viewport = (width) => cdp('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: width < 700 });
    const motion = (value) => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
    const style = (selector, property) => evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)}))[${JSON.stringify(property)}]`);
    const pressKey = async (key, code, windowsVirtualKeyCode) => {
      // Chrome needs the carriage return to trigger native Enter activation.
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
    };
    const screenshot = async (name, selector) => {
      if (!process.env.GATEWAY_UI_SCREENSHOTS) return;
      const directory = path.resolve(process.env.GATEWAY_UI_SCREENSHOTS);
      fs.mkdirSync(directory, { recursive: true });
      const clip = selector ? await evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        return { x: rect.left + scrollX, y: rect.top + scrollY, width: rect.width, height: rect.height, scale: 1 };
      })()`) : undefined;
      const image = await cdp('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) });
      fs.writeFileSync(path.join(directory, `${name}.png`), Buffer.from(image.data, 'base64'));
    };

    await cdp('Runtime.enable');
    await cdp('Page.enable');
    await viewport(1440);
    await motion('no-preference');
    await cdp('Page.navigate', { url: base });
    await waitFor('Boolean(window.ModelGroups && document.querySelector("#dashboard:not(.hidden)"))');
    const settled = 'document.getAnimations().every(animation => animation.playState === "finished")';
    const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth';
    const tabs = await evaluate('[...document.querySelectorAll(".tab")].map(tab => tab.dataset.tab)');
    assert.equal(await evaluate('document.querySelectorAll(".nav-icon[aria-hidden=true]").length'), tabs.length);
    for (const tab of tabs) {
      await evaluate(`document.querySelector('[data-tab="${tab}"]').click()`);
      assert.equal(await evaluate('document.querySelector(".tab.active").dataset.tab'), tab);
      assert.equal(await evaluate(`[...document.querySelectorAll('.dashboard-card:not(.hidden)')].every(panel => panel.dataset.tabPage === '${tab}')`), true);
      assert.equal(await style('.dashboard-card:not(.hidden)', 'animationName'), 'gateway-reveal');
    }
    await evaluate('switchTab("about")');
    await waitFor(settled);
    assert.equal(await evaluate('/^v?\\d+\\.\\d+\\.\\d+$/.test(document.querySelector("#aboutVersion").textContent)'), true, '关于页应显示当前版本');
    const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    assert.equal(await evaluate('document.querySelector("#aboutVersion").textContent.replace(/^v/, "")'), packageVersion);
    assert.equal(await evaluate('document.querySelectorAll("#aboutVersion").length'), 1);
    const aboutLinks = await evaluate('[...document.querySelectorAll(".about-panel a")].map(link => ({href:link.href, target:link.target, rel:link.rel}))');
    const repository = 'https://github.com/Guyao146/Sakura-AI-Gateway';
    for (const href of [repository, `${repository}/issues`, `${repository}/blob/main/LICENSE`, `${repository}/blob/main/LICENSING.md`, `${repository}/blob/main/wiki/index.md`, 'https://github.com/markedjs/marked']) {
      assert(aboutLinks.some(link => link.href === href), `关于页应保留资源入口: ${href}`);
    }
    assert(aboutLinks.every(link => link.href.startsWith('https://') && link.target === '_blank' && link.rel.split(/\s+/).includes('noopener') && link.rel.split(/\s+/).includes('noreferrer')), '外链应安全地在新标签页打开');
    const licenseText = await evaluate('document.querySelector(".about-license").textContent');
    assert.match(licenseText, /Sakura-License v1\.2/);
    assert.equal(await evaluate('document.querySelector(".about-kicker").textContent'), 'Sakura-AI-Gateway');
    assert.equal(await evaluate('document.querySelector(".sidebar-version .muted").textContent'), 'Sakura-AI-Gateway');
    // 偏好存储使用新项目名，并能正常读写（旧键不得再被写入）。
    await evaluate('switchTab("settings")');
    assert.equal(await evaluate(`localStorage.getItem("sakura-ai-gateway.active-tab.v2")`), 'settings', '标签偏好应写入新键');
    for (const key of ['local-model-gateway.panel-order.v1', 'local-model-gateway.active-tab.v2', 'local-model-gateway.card-order.v1']) {
      assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(key)}) === null`), true, `不应再写入旧键：${key}`);
    }
    await evaluate('switchTab("about")');
    assert.match(licenseText, /不是 OSI 批准的开源许可证/);
    assert.match(licenseText, /v2\.4\.0 及之前.*LGPL-2\.1/);
    const credits = await evaluate('document.querySelector("[aria-labelledby=aboutCreditsHeading]").textContent');
    for (const text of ['marked v12.0.2', 'Christopher Jeffrey', 'MIT']) assert(credits.includes(text));
    assert.equal(await evaluate('document.querySelector(".about-notice").open'), false);
    await evaluate('document.querySelector(".about-actions a").focus()');
    for (let index = 1; index < aboutLinks.length; index += 1) {
      await pressKey('Tab', 'Tab', 9);
      assert.equal(await evaluate('document.activeElement.href'), aboutLinks[index].href, '关于页链接应可按顺序使用键盘访问');
      assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid');
    }
    await pressKey('Tab', 'Tab', 9);
    assert.equal(await evaluate('document.activeElement.matches(".about-notice summary")'), true);
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid');
    await pressKey('Enter', 'Enter', 13);
    assert.equal(await evaluate('document.querySelector(".about-notice").open'), true, '键盘应能展开授权说明');
    await pressKey('Enter', 'Enter', 13);
    assert.equal(await evaluate('document.querySelector(".about-notice").open'), false);
    await evaluate('document.activeElement.blur(); window.scrollTo(0, 0)');
    for (const width of [1440, 1101, 1100, 1024, 768, 701, 700, 390, 320]) {
      await viewport(width);
      await waitFor(settled);
      assert.equal((await style('.about-grid', 'gridTemplateColumns')).split(' ').length, width > 1100 ? 2 : 1, `${width}px 关于页卡片列数`);
      assert.equal(await style('.about-mark', 'width'), width <= 700 ? '44px' : '64px', `${width}px 品牌图标应适配断点`);
      for (const open of [true, false]) {
        await evaluate(`document.querySelector('.about-notice').open = ${open}`);
        assert.equal(await evaluate(noOverflow), true, `${width}px 关于页${open ? '展开' : '折叠'}说明不应横向溢出`);
        assert.equal(await evaluate('[...document.querySelectorAll(".about-hero, .about-card, .about-notice, .about-panel a")].every(element => element.scrollWidth <= element.clientWidth + 1)'), true, `${width}px 关于页内容不应溢出卡片或链接`);
      }
      if ([1440, 701, 700, 390, 320].includes(width)) await screenshot(`about-${width}`, '.about-panel');
    }
    await viewport(1440);
    await evaluate('switchTab("metrics")');
    await waitFor(settled);
    await evaluate('refreshMetrics()');
    assert.equal(await evaluate('document.querySelector("#statsGrid").getAnimations({subtree:true}).length'), 0, '自动刷新不能重播卡片动画');
    await screenshot('metrics-desktop');
    await evaluate('switchTab("logs")');
    await waitFor(settled);
    assert.equal(await evaluate('document.querySelectorAll("#logSearchInput").length'), 1, '日志筛选栏应存在搜索框');
    assert.equal(await evaluate('document.querySelectorAll("#logKeyFilter").length'), 1, '日志筛选栏应存在 Key 下拉框');
    assert.equal(await evaluate('document.querySelectorAll("#logRangeFrom").length'), 1, '日志筛选栏应存在开始时间');
    assert.equal(await evaluate('document.querySelectorAll("#logRangeTo").length'), 1, '日志筛选栏应存在结束时间');
    assert.equal(await evaluate('document.querySelector("#requestLogSummary").textContent'), '仅记录元数据', '空日志时应显示占位文案');
    await evaluate('document.querySelector("#logSearchInput").value = "不存在的关键字"; document.querySelector("#logSearchInput").dispatchEvent(new Event("input"))');
    // 输入后有 300ms 防抖 + 一次后端请求，等待摘要真正更新再断言。
    await waitFor('document.querySelector("#requestLogSummary").textContent.includes("筛选")');
    const summaryText = await evaluate('document.querySelector("#requestLogSummary").textContent');
    assert.match(summaryText, /筛选：关键字/, `摘要应显示当前筛选条件，实际：${summaryText}`);
    await evaluate('document.querySelector("#resetLogFilterButton").click()');
    await waitFor('document.querySelector("#logSearchInput").value === ""');
    assert.equal(await evaluate('document.querySelector("#logSearchInput").value'), '', '重置应清空搜索框');
    await screenshot('logs-filter-bar', '.panel[data-tab-page="logs"]');
    // 全屏宽度：不再有 1360px 上限，只保留两侧呼吸边距。
    // 全屏宽度：不再有 1360px 上限，1440px 视口下 shell 应明显超过旧上限（减去滚动条宽度误差）。
    assert.ok(await evaluate('document.querySelector(".shell").getBoundingClientRect().width > 1360'), '桌面端页面应铺满全宽');
    // 日志表格应有竖向滚动区域与粘性表头。
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".request-log-table")).overflowY'), 'auto', '日志表格应有竖向滚动');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".request-log-table thead th")).position'), 'sticky', '日志表头应吸顶');
    // 内容可选择复制：面板与卡片默认不带 draggable，只有手柄按下时才启用。
    assert.equal(await evaluate('document.querySelector("[data-panel-id]").draggable'), false, '面板默认应不可拖拽以保证内容可选中复制');
    assert.equal(await evaluate('getComputedStyle(document.body).userSelect'), 'text', '页面正文应允许文本选择');
    // 拖拽排序仍可用：只有按住 ⋮⋮ 手柄才能拖动面板，且松手后恢复 draggable=false。
    await evaluate('switchTab("overview")');
    await waitFor(settled);
    // 面板按标签页显隐，拖拽要在当前可见的两个面板之间进行。
    // 无头 Chrome 的 CDP Input 不触发 HTML5 拖拽，所以用合成 DragEvent 走完整 dragstart/dragover/drop/dragend 流程。
    await waitFor('[...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")].length >= 2');
    const otherId = await evaluate('[...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")][1].dataset.panelId');
    const before = await evaluate('JSON.stringify([...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")].map(panel => panel.dataset.panelId))');
    await evaluate('(() => { const panels = [...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")]; const handle = panels[0].querySelector("[data-panel-drag-handle]"); const dataTransfer = new DataTransfer(); handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); panels[0].dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer })); const target = panels[1]; const rect = target.getBoundingClientRect(); target.dispatchEvent(new DragEvent("dragover", { bubbles: true, clientY: rect.bottom - 20, dataTransfer })); target.dispatchEvent(new DragEvent("drop", { bubbles: true, clientY: rect.bottom - 20, dataTransfer })); panels[0].dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer })); return true; })()');
    await waitFor('JSON.stringify([...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")].map(panel => panel.dataset.panelId)) !== ' + JSON.stringify(before));
    const movedId = await evaluate('[...document.querySelectorAll("#dashboard > [data-panel-id]:not(.hidden)")][0].dataset.panelId');
    assert.equal(movedId, otherId, '手柄拖拽应能交换面板顺序');
    assert.equal(await evaluate('document.querySelector("#dashboard > [data-panel-id]").draggable'), false, '拖拽结束后面板应恢复为不可拖拽');
    await evaluate('switchTab("overview")');
    await waitFor(settled);
    await screenshot('dashboard-desktop');
    await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
    assert.equal(await evaluate('document.querySelector("#upstreamDialog").open'), true);
    assert.equal(await style('#upstreamDialog', 'animationName'), 'gateway-dialog');
    assert.equal(await evaluate('document.activeElement.closest("dialog")?.id'), 'upstreamDialog');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await waitFor('!document.querySelector("#upstreamDialog").open');
    await evaluate('toast("界面测试完成")');
    await waitFor('getComputedStyle(document.querySelector("#toast")).opacity === "1"');
    await evaluate('clearTimeout(toast.timer); document.querySelector("#toast").className = "toast"');
    await waitFor('getComputedStyle(document.querySelector("#toast")).opacity === "0"');
    for (const width of [1024, 768, 390, 320]) {
      await viewport(width);
      for (const tab of tabs) {
        await evaluate(`switchTab('${tab}')`);
        assert.equal(await evaluate(noOverflow), true, `${width}px / ${tab} 不应横向溢出`);
      }
      await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
      assert.equal(await evaluate('document.querySelector("#upstreamDialog").scrollWidth <= document.querySelector("#upstreamDialog").clientWidth'), true, `${width}px 弹窗不应横向溢出`);
      await evaluate('document.querySelector("[data-dialog-close=upstreamDialog]").click()');
    }
    await evaluate('switchTab("overview")');
    await waitFor(settled);
    await screenshot('dashboard-mobile');
    await motion('reduce');
    await evaluate('switchTab("upstreams"); document.querySelector("#addUpstreamButton").click()');
    assert.equal(await style('#upstreamDialog', 'animationName'), 'none');
    assert.equal(await style('.dashboard-card:not(.hidden)', 'animationName'), 'none');
    assert.equal(await style('.button', 'transitionDuration'), '0s');
    await evaluate('document.querySelector("[data-dialog-close=upstreamDialog]").click(); document.querySelector("#loadButton").focus()');
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    assert.equal(await evaluate('getComputedStyle(document.activeElement).outlineStyle'), 'solid', '键盘焦点应可见');
    await evaluate('switchTab("about")');
    assert.equal(await style('.about-panel', 'animationName'), 'none');
    assert.equal(await style('.about-actions .button', 'transitionDuration'), '0s');
    assert.equal(await evaluate('document.querySelector(".about-panel").getAnimations({subtree:true}).length'), 0, '关于页应尊重减少动态效果偏好');

    // Mock only the session response so localhost can display the login page.
    await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
      const originalFetch = window.fetch;
      window.fetch = (input, options) => input === '/auth/status'
        ? Promise.resolve(new Response(JSON.stringify({authenticated:false, configured:true, remoteMode:'password'}), {headers:{'Content-Type':'application/json'}}))
        : originalFetch(input, options);
    ` });
    await viewport(1440);
    await motion('no-preference');
    await cdp('Page.navigate', { url: `${base}/login.html` });
    await waitFor('Boolean(document.querySelector("#passwordLoginForm:not(.hidden)"))');
    assert.equal(await style('.login-card', 'animationName'), 'gateway-reveal');
    await waitFor(settled);
    await screenshot('login-desktop');
    await evaluate('document.querySelector("#passwordLoginButton").click()');
    assert.equal(await evaluate('document.querySelector("#loginError").textContent'), '请输入用户名和密码');
    for (const width of [1024, 900, 768, 390, 320]) {
      await viewport(width);
      assert.equal(await evaluate(noOverflow), true, `${width}px 登录页不应横向溢出`);
      assert.equal(await style('#passwordLoginForm', 'display'), 'grid');
      assert.equal(await style('#loginActions', 'display'), 'none', '隐藏状态不能被动画覆盖');
    }
    await waitFor(settled);
    await screenshot('login-mobile');
    await motion('reduce');
    await evaluate('setStatus("检查会话", "请稍候")');
    assert.equal(await style('.login-spinner', 'animationName'), 'none');
    assert.equal(await style('.login-card', 'animationName'), 'none');
    assert.equal(await evaluate('document.getAnimations().length'), 0);
    await evaluate('showOidcLogin()');
    assert.equal(await style('#passwordLoginForm', 'display'), 'none');
    assert.equal(await style('#loginActions', 'display'), 'grid');
    assert.deepEqual(exceptions, [], '浏览器不应出现未处理异常');
    console.log('UI browser tests passed (navigation, about page, dialogs, responsive layout, login, reduced motion)');
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    socket?.close();
    if (browser && browser.exitCode === null) {
      if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already exited */ }
      } else {
        const exited = once(browser, 'exit');
        browser.kill();
        await exited;
      }
    }
    if (gateway && gateway.exitCode === null) {
      const exited = once(gateway, 'exit');
      gateway.kill();
      await exited;
    }
    await pause(300);
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
