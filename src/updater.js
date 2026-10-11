const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function downloadFile(url, target) {
  const response = await fetch(url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Sakura-AI-Gateway-Updater' } });
  if (!response.ok) throw new Error(`下载升级包失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(target, buffer, { mode: 0o600 });
  return buffer;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} 退出码 ${code}: ${output.slice(-2000)}`)));
  });
}

async function waitForParentExit(pid) {
  for (let i = 0; i < 100; i += 1) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  try { process.kill(pid); } catch { /* already stopped */ }
  await sleep(500);
}

async function extractArchive(archive, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const listing = await run('tar', ['-tzf', archive]);
  for (const rawEntry of listing.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    const entry = rawEntry.replace(/\\/g, '/');
    if (entry.startsWith('/') || /^[A-Za-z]:\//.test(entry) || entry.split('/').includes('..')) {
      throw new Error('升级包包含不安全的路径');
    }
  }
  await run('tar', ['-xzf', archive, '-C', destination]);
}

async function findPackageRoot(directory) {
  const direct = path.join(directory, 'package.json');
  if (fs.existsSync(direct)) return directory;
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'data' || entry.name.startsWith('.')) continue;
    const candidate = path.join(directory, entry.name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  throw new Error('升级包缺少 package.json');
}

async function copyProgram(source, target) {
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'data' || entry.name === '.git' || entry.name.startsWith('.update-') || entry.name.startsWith('.backup-')) continue;
    await fsp.cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: true });
  }
}

async function update(options) {
  const root = path.resolve(options.root);
  const temp = path.join(root, `.update-${process.pid}-${Date.now()}`);
  const archive = path.join(temp, 'release.tar.gz');
  const extracted = path.join(temp, 'extracted');
  const backup = path.join(root, `.backup-${options.version}-${Date.now()}`);
  try {
    await fsp.mkdir(temp, { recursive: true });
    await downloadFile(options.url, archive);
    const actual = await sha256(archive);
    if (actual !== String(options.digest).replace(/^sha256:/i, '').toLowerCase()) throw new Error('升级包 SHA-256 校验失败');
    await extractArchive(archive, extracted);
    const source = await findPackageRoot(extracted);
    const packageInfo = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
    if (String(packageInfo.version) !== String(options.version)) throw new Error(`升级包版本不匹配：${packageInfo.version}`);
    await fsp.mkdir(backup, { recursive: true });
    await copyProgram(root, backup);
    await copyProgram(source, root);
    await fsp.rm(temp, { recursive: true, force: true });
    await fsp.rm(backup, { recursive: true, force: true });
    spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (error) {
    try {
      if (fs.existsSync(backup)) await copyProgram(backup, root);
    } finally {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
    spawn(process.execPath, [path.join(root, 'src', 'server.js')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    throw error;
  }
}

async function main() {
  const options = JSON.parse(process.argv[2] || '{}');
  await waitForParentExit(Number(options.parentPid));
  await update(options);
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });

module.exports = { compare: sha256, findPackageRoot, update };