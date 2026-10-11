const assert = require('node:assert/strict');
const { compareVersions, isTrustedDownloadUrl, releaseToPublic, versionParts } = require('../src/update-checker');

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
console.log('update checker tests passed');