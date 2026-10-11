const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { prepareUserData } = require('./data-directory');

let gatewayPort = 0;
let gatewayProcess;
let logStream;
let mainWindow;
let settingsWindow;
let restartingGateway = false;

function portSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-port-settings.json');
}

function readPortSettings() {
  try {
    const value = JSON.parse(fs.readFileSync(portSettingsPath(), 'utf8'));
    const mode = value.mode === 'fixed' ? 'fixed' : 'random';
    const port = Number(value.port);
    return { mode, port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8787 };
  } catch {
    return { mode: 'random', port: 8787 };
  }
}

function writePortSettings(value) {
  const mode = value?.mode === 'fixed' ? 'fixed' : 'random';
  const port = Number(value?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1 到 65535 之间的整数');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(portSettingsPath(), `${JSON.stringify({ mode, port }, null, 2)}\n`);
  return { mode, port };
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

function gatewayRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'gateway') : path.join(__dirname, 'gateway');
}

function waitForGateway(port, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const request = http.get(`http://127.0.0.1:${port}/health`, (response) => {
        response.resume();
        if (response.statusCode === 200) resolve();
        else retry();
      });
      request.on('error', retry);
      request.setTimeout(1000, () => request.destroy());
    };
    const retry = () => Date.now() - started >= timeoutMs ? reject(new Error('本地网关启动超时')) : setTimeout(probe, 250);
    probe();
  });
}

async function startGateway() {
  const settings = readPortSettings();
  if (settings.mode === 'fixed' && !await isPortAvailable(settings.port)) {
    throw new Error(`固定端口 ${settings.port} 已被占用，请更换端口或切换为随机端口`);
  }
  gatewayPort = settings.mode === 'fixed' ? settings.port : await findFreePort();
  const root = gatewayRoot();
  const entry = path.join(root, 'src', 'server.js');
  if (!fs.existsSync(entry)) throw new Error(`缺少网关文件：${entry}`);
  const dataDir = path.join(app.getPath('userData'), 'gateway-data');
  fs.mkdirSync(dataDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(app.getPath('userData'), 'gateway.log'), { flags: 'a' });
  gatewayProcess = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HOST: '127.0.0.1',
      PORT: String(gatewayPort),
      SAKURA_AI_GATEWAY_FORCE_HOST: '127.0.0.1',
      SAKURA_AI_GATEWAY_FORCE_PORT: String(gatewayPort),
      SAKURA_AI_GATEWAY_FORCE_SETTINGS: 'true',
      SAKURA_AI_GATEWAY_DATA_DIR: dataDir
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  gatewayProcess.once('error', (error) => {
    logStream?.write(`[client] 无法启动本地网关子进程：${error.stack || error.message}\n`);
  });
  gatewayProcess.on('exit', (code) => {
    if (code !== 0) logStream?.write(`[client] Sakura-AI-Gateway 子进程退出，代码：${code}\n`);
  });
  gatewayProcess.on('close', (code, signal) => {
    if (!restartingGateway && !mainWindow?.isDestroyed() && code !== 0) {
      mainWindow.loadURL(statusHtml('Sakura-AI-Gateway 启动失败', `网关子进程已退出（代码 ${code ?? '未知'}，信号 ${signal || '无'}）。\n\n诊断日志：${path.join(app.getPath('userData'), 'gateway.log')}`)).catch(() => {});
    }
  });
  gatewayProcess.stdout?.pipe(logStream, { end: false });
  gatewayProcess.stderr?.pipe(logStream, { end: false });
}

function settingsHtml() {
  return `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui;padding:22px;background:#171c1e;color:#edf3ef}label{display:block;margin:14px 0 6px}select,input,button{font:14px system-ui;padding:8px;border-radius:6px;border:1px solid #465254;background:#101315;color:#edf3ef}input{width:100px}button{margin:22px 8px 0 0;cursor:pointer}.hint{color:#98a6a1;font-size:12px}</style><h2>本地网关端口</h2><label for="mode">启动端口模式</label><select id="mode"><option value="random">每次启动随机端口</option><option value="fixed">固定端口（推荐，方便客户端配置）</option></select><label for="port">固定端口</label><input id="port" type="number" min="1" max="65535" step="1"><div class="hint">固定端口被占用时会显示错误，请选择其他端口。</div><button id="save">保存并重启网关</button><button id="cancel">取消</button><script>const mode=document.querySelector('#mode'),port=document.querySelector('#port'); window.desktopPortSettings.get().then(x=>{mode.value=x.mode;port.value=x.port;mode.onchange()}); mode.onchange=()=>port.disabled=mode.value!=='fixed'; document.querySelector('#save').onclick=async()=>{try{await window.desktopPortSettings.save({mode:mode.value,port:Number(port.value)});window.close()}catch(e){alert(e.message)}};document.querySelector('#cancel').onclick=()=>window.close();</script>`;
}

function openPortSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow.focus();
  settingsWindow = new BrowserWindow({ width: 390, height: 330, resizable: false, parent: mainWindow, modal: true, title: '端口设置', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  settingsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(settingsHtml())}`);
}

ipcMain.handle('port-settings:get', () => readPortSettings());
ipcMain.handle('port-settings:save', async (_, settings) => {
  const saved = writePortSettings(settings);
  restartingGateway = true;
  try {
    if (gatewayProcess && !gatewayProcess.killed) gatewayProcess.kill();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await startGateway();
    await waitForGateway(gatewayPort);
    await mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/`);
  } catch (error) {
    await mainWindow.loadURL(statusHtml('网关重启失败', `${error.message}\n\n设置文件：${portSettingsPath()}`));
    throw error;
  } finally {
    restartingGateway = false;
  }
  return saved;
});

function statusHtml(title, detail) {
  const safe = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#101315;color:#edf3ef;font:15px system-ui;display:grid;place-items:center;height:100vh}.box{max-width:680px;padding:34px;border:1px solid #303a3c;border-radius:14px;background:#171c1e}h1{font-size:24px}p{color:#98a6a1;line-height:1.7;white-space:pre-wrap}</style><div class="box"><h1>${safe(title)}</h1><p>${safe(detail)}</p></div>`)}`;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    title: 'Sakura-AI-Gateway · Electron',
    autoHideMenuBar: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    { label: '设置', submenu: [{ label: '端口设置…', click: openPortSettings }] },
    { label: '帮助', submenu: [{ label: '打开日志目录', click: () => require('node:child_process').execFile('explorer.exe', [app.getPath('userData')]) }] }]));
  await mainWindow.loadURL(statusHtml('正在启动 Sakura-AI-Gateway', '正在准备内嵌 Node.js 服务，请稍候…'));
  try {
    await startGateway();
    await waitForGateway(gatewayPort);
    await mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/`);
  } catch (error) {
    const logPath = path.join(app.getPath('userData'), 'gateway.log');
    await mainWindow.loadURL(statusHtml('Sakura-AI-Gateway 启动失败', `${error.stack || error.message}\n\n诊断日志：${logPath}`));
  }
}

app.whenReady().then(() => {
  app.setName('Sakura-AI-Gateway Electron');
  app.setAppUserModelId('cn.mcylyr.sakuraaigateway.electron');
  app.setPath('userData', prepareUserData(app.getPath('appData')));
  return createWindow();
}).catch((error) => {
  dialog.showErrorBox('Sakura-AI-Gateway 启动失败', error.stack || error.message);
  app.quit();
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (gatewayProcess) gatewayProcess.kill(); logStream?.end(); });