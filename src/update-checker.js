const UPDATE_REPOSITORY = 'Guyao146/Sakura-AI-Gateway';
const GITHUB_RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`;

function versionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
  const a = versionParts(left) || [0, 0, 0];
  const b = versionParts(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function releaseToPublic(release) {
  const tag = String(release?.tag_name || '').trim();
  const version = tag.replace(/^v/i, '');
  if (!versionParts(version)) return null;
  return {
    version,
    tag,
    name: String(release.name || tag).slice(0, 200),
    body: String(release.body || '').slice(0, 12000),
    url: String(release.html_url || '').slice(0, 500),
    publishedAt: release.published_at || release.created_at || null,
    prerelease: release.prerelease === true,
    assets: Array.isArray(release.assets) ? release.assets.map((asset) => ({
      name: String(asset.name || '').slice(0, 200),
      url: String(asset.browser_download_url || '').slice(0, 500),
      size: Number(asset.size) || 0,
      digest: typeof asset.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(asset.digest) ? asset.digest.toLowerCase() : null
    })).filter((asset) => asset.name && asset.url) : []
  };
}

function isUpgradeArchive(asset, version) {
  if (!asset || !asset.digest) return false;
  const expected = String(version || '').replace(/^v/i, '');
  const name = String(asset.name || '').toLowerCase();
  return (name === `sakura-ai-gateway-v${expected}.tar.gz` || name === `sakura-ai-gateway-${expected}.tar.gz`)
    && name.endsWith('.tar.gz');
}

async function checkLatestRelease(currentVersion, options = {}) {
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 8000, 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Sakura-AI-Gateway-Update-Checker' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
    const releases = await response.json();
    const latest = Array.isArray(releases)
      ? releases.map(releaseToPublic).filter(Boolean).find((release) => !release.prerelease)
      : null;
    if (!latest) throw new Error('GitHub 暂无可用 Release');
    return {
      repository: UPDATE_REPOSITORY,
      checkedAt: new Date().toISOString(),
      currentVersion: String(currentVersion || ''),
      latest,
      upgradeAsset: latest.assets.find((asset) => isUpgradeArchive(asset, latest.version)) || null,
      updateAvailable: compareVersions(latest.version, currentVersion) > 0
    };
  } finally {
    clearTimeout(timer);
  }
}

function isTrustedDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
  } catch { return false; }
}

module.exports = { UPDATE_REPOSITORY, compareVersions, checkLatestRelease, isTrustedDownloadUrl, isUpgradeArchive, releaseToPublic, versionParts };