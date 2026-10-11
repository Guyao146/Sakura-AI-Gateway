const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const brand = 'Sakura-AI-Gateway';
const slug = 'sakura-ai-gateway';
const repository = `Guyao146/${brand}`;
const pkg = JSON.parse(read('package.json'));
const electron = JSON.parse(read('clients/electron/package.json'));
assert.equal(pkg.name, slug);
assert.equal(electron.name, `${slug}-electron`);
assert.equal(electron.build.productName, `${brand} Electron`);
assert.equal(electron.build.appId, 'cn.mcylyr.sakuraaigateway.electron');
for (const target of ['nsis', 'portable']) assert(electron.build[target].artifactName.startsWith(`${brand}-`));
assert(read('public/index.html').includes(`<title>${brand}</title>`));
assert(read('public/login.html').includes(`<title>登录 · ${brand}</title>`));
assert(read('wiki/index.html').includes(`<title>${brand} · Wiki</title>`));
assert(new RegExp(`^# ${brand}\\r?\\n`).test(read('README.md')));
assert(read('LICENSING.md').includes(`https://github.com/${repository}`));
assert(read('docker-compose.yml').includes(`ghcr.io/guyao146/${slug}:`));
const workflow = read('.github/workflows/release.yml');
assert(workflow.includes(`ghcr.io/guyao146/${slug}:`));
assert(workflow.includes(`clients/webview2/${brand}.WebView2.csproj`));
assert(workflow.includes(`${brand}-v$version.tar.gz`));
assert(read(`clients/webview2/${brand}.WebView2.csproj`).includes(`<AssemblyName>${brand}.WebView2</AssemblyName>`));
assert(read(`desktop-client/${brand}.Client.csproj`).includes(`<AssemblyName>${brand}</AssemblyName>`));
const { UPDATE_REPOSITORY, isUpgradeArchive } = require('../src/update-checker');
assert.equal(UPDATE_REPOSITORY, repository);
const digest = `sha256:${'a'.repeat(64)}`;
assert.equal(isUpgradeArchive({ name: `${brand}-v2.6.0.tar.gz`, digest }, '2.6.0'), true);
assert.equal(isUpgradeArchive({ name: `${slug}-2.6.0.tar.gz`, digest }, 'v2.6.0'), true);
assert.equal(isUpgradeArchive({ name: `${brand}-v2.6.0.tar.gz` }, '2.6.0'), false);
assert.equal(isUpgradeArchive({ name: `${brand}-v2.5.2.tar.gz`, digest }, '2.6.0'), false);

// Only explicit migration paths may mention the old identity. Scan sources, not build artifacts/data.
const migrationFiles = new Set([
  'src/config.js', 'src/metrics.js', 'public/app.js', 'clients/electron/data-directory.js',
  'clients/shared/DesktopData.cs', 'test/brand-migration.test.js', 'test/branding.test.js',
  'test/ui.browser.test.js', 'test/integration-auth.test.js', 'wiki/migration.md'
]);
const oldName = /local[-_ .]*model[-_ .]*gateway|\blmg[_-]|本地模型网关/i;
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
for (const file of new Set(files)) {
  if (!fs.existsSync(path.join(root, file))) continue; // Renamed files can remain in the index before commit.
  assert(!oldName.test(file), `旧项目名仍存在于文件路径：${file}`);
  if (!migrationFiles.has(file)) assert(!oldName.test(read(file)), `非迁移文件仍使用旧名称：${file}`);
}
console.log('branding tests passed');