const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const startedMarker = /Sakura-AI-Gateway 已启动：http:\/\/127\.0\.0\.1:\d+/;

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-brand-'));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

// 用真实网关进程验证环境变量与启动标识；只需启动到健康检查即可，不做上游请求。
async function startGateway(env) {
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'server.js')], {
    cwd: projectRoot,
    env: { ...process.env, ...env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时：${output}`)), 12000);
    const check = () => {
      if (startedMarker.test(output)) { clearTimeout(timer); resolve(); return; }
      if (child.exitCode !== null) { clearTimeout(timer); reject(new Error(output)); return; }
      setTimeout(check, 50);
    };
    check();
  });
  try {
    await ready;
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 200, output);
    assert.equal((await health.json()).service, 'sakura-ai-gateway', '健康检查应使用新服务标识');
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function main() {
  // 新环境变量选择数据目录并生成配置。
  const latest = tempDirectory();
  await startGateway({ SAKURA_AI_GATEWAY_DATA_DIR: latest });
  assert.ok(fs.existsSync(path.join(latest, 'config.json')), '新环境变量应指向数据目录并生成配置');
  fs.rmSync(latest, { recursive: true, force: true });

  // 旧环境变量仍是兼容入口。
  const legacy = tempDirectory();
  await startGateway({ LOCAL_MODEL_GATEWAY_DATA_DIR: legacy });
  assert.ok(fs.existsSync(path.join(legacy, 'config.json')), '旧环境变量应继续兼容');
  fs.rmSync(legacy, { recursive: true, force: true });

  // 新变量优先于旧变量。
  const precedence = tempDirectory();
  const unused = path.join(os.tmpdir(), 'sakura-ai-gateway-brand-unused');
  await startGateway({ SAKURA_AI_GATEWAY_DATA_DIR: precedence, LOCAL_MODEL_GATEWAY_DATA_DIR: unused });
  assert.ok(fs.existsSync(path.join(precedence, 'config.json')), '新变量优先于旧变量');
  assert.ok(!fs.existsSync(unused), '旧变量目录不应被创建');
  fs.rmSync(precedence, { recursive: true, force: true });

  console.log('brand migration tests passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});