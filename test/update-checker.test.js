const assert = require('node:assert/strict');
const { checkLatestRelease, compareVersions, isTrustedDownloadUrl, releaseToPublic, versionParts } = require('../src/update-checker');

assert.deepEqual(versionParts('v1.2.3'), [1, 2, 3]);
assert.equal(compareVersions('1.2.0', '1.1.9') > 0, true);
assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
const release = releaseToPublic({ tag_name: 'v1.0.0', name: 'First', body: 'notes', html_url: 'https://github.com/example/release', published_at: '2026-01-01T00:00:00Z', assets: [{ name: 'app.exe', browser_download_url: 'https://github.com/example/app.exe', size: 123 }] });
assert.equal(release.version, '1.0.0');
assert.equal(release.assets[0].name, 'app.exe');
assert.equal(releaseToPublic({ tag_name: 'not-a-version' }), null);
assert.equal(isTrustedDownloadUrl('https://github.com/Guyao146/Sakura-AI-Gateway/releases/download/v1.0.0/Sakura-AI-Gateway-v1.0.0.tar.gz'), true);
assert.equal(isTrustedDownloadUrl('https://example.com/update.tar.gz'), false);
assert.equal(isTrustedDownloadUrl('http://github.com/example/update.tar.gz'), false);
console.log('update checker unit tests passed');

// checkLatestRelease：模拟 GitHub /releases 响应，验证稳定版列表与版本标记。
const originalFetch = global.fetch;
const fakeReleases = [
  { tag_name: 'v2.8.0', name: 'Sakura-AI-Gateway 2.8.0', body: '- 修复\n- 优化', published_at: '2026-09-01T00:00:00Z', assets: [] },
  { tag_name: 'v2.7.0-beta', name: 'Beta', body: 'beta', prerelease: true, published_at: '2026-08-20T00:00:00Z', assets: [] },
  { tag_name: 'v2.7.0', name: 'Sakura-AI-Gateway 2.7.0', body: '## 新功能\n- A\n- B', published_at: '2026-08-01T00:00:00Z', assets: [] },
  { tag_name: 'v2.6.0', name: 'Sakura-AI-Gateway 2.6.0', body: '改名', published_at: '2026-07-01T00:00:00Z', assets: [{ name: 'Sakura-AI-Gateway-v2.6.0.tar.gz', browser_download_url: 'https://github.com/Guyao146/Sakura-AI-Gateway/releases/download/v2.6.0/Sakura-AI-Gateway-v2.6.0.tar.gz', size: 1000, digest: 'sha256:' + 'a'.repeat(64) }] },
  { tag_name: 'v2.5.2', name: 'Old', body: '旧版本', published_at: '2026-06-01T00:00:00Z', assets: [] }
];
global.fetch = async () => ({ ok: true, json: async () => fakeReleases });

(async () => {
  try {
    const result = await checkLatestRelease('2.6.0', { listLimit: 2, timeoutMs: 2000 });
    assert.equal(result.latest.version, '2.8.0', '最新稳定版应跳过预发布');
    assert.equal(result.latest.prerelease, false);
    assert.equal(result.updateAvailable, true);
    assert.equal(result.releases.length, 2, 'releases 应遵守 listLimit');
    assert.equal(result.releases[0].version, '2.8.0');
    assert.equal(result.releases[1].version, '2.7.0', '列表应跳过预发布版本');
    assert.equal(result.releases.some((item) => item.prerelease), false);
    const current = result.releases.find((item) => item.isCurrent);
    assert.ok(!current, '列表被截断时当前版本可以不在列表中');
    assert.equal(result.upgradeAsset, null, '升级包取自最新版，v2.8.0 没有升级包');

    const full = await checkLatestRelease('2.6.0', { timeoutMs: 2000 });
    assert.equal(full.releases.length, 4, '默认应返回 6 条以内的全部稳定版');
    const currentEntry = full.releases.find((item) => item.isCurrent);
    assert.ok(currentEntry && currentEntry.version === '2.6.0', '当前版本应被标记 isCurrent');

    const clamped = await checkLatestRelease('2.6.0', { listLimit: 99, timeoutMs: 2000 });
    assert.equal(clamped.releases.length, 4, 'listLimit 超过上限时按实际稳定版数量返回');
    assert.equal(clamped.repository, 'Guyao146/Sakura-AI-Gateway');

    global.fetch = async () => ({ ok: true, json: async () => [] });
    await assert.rejects(checkLatestRelease('2.6.0', { timeoutMs: 2000 }), /GitHub 暂无可用 Release/);
  } finally {
    global.fetch = originalFetch;
  }
  console.log('update checker release list tests passed');
})();