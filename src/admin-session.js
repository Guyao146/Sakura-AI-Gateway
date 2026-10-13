/**
 * 管理会话令牌：签发与校验。
 *
 * 令牌为无状态签名 cookie：base64url(payload).hmac(payload)。
 * payload 含签发时间、过期时间、随机数与登录主体（模式 / 用户 / 凭据版本）。
 * HMAC 密钥持久化在数据目录下的 .admin_session_secret（0600），
 * 也可用 SAKURA_AI_GATEWAY_ADMIN_SESSION_SECRET 覆盖。
 * 进程重启后既有会话仍然有效；改密、停用账号或删除账号会改变凭据版本，
 * 旧令牌在下一次校验时立即失效。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SESSION_COOKIE = 'sakura_ai_gateway_admin_session';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const SECRET_FILENAME = '.admin_session_secret';
const SECRET_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const dataDir = () => (process.env.SAKURA_AI_GATEWAY_DATA_DIR ?? process.env.LOCAL_MODEL_GATEWAY_DATA_DIR)
  || path.join(__dirname, '..', 'data');

const REVOKED_PATH = () => path.join(dataDir(), '.admin_session_revoked');

let revokedSet = null;

function loadRevoked() {
  if (revokedSet !== null) return revokedSet;
  try {
    revokedSet = new Set(JSON.parse(fs.readFileSync(REVOKED_PATH(), 'utf8')));
  } catch (error) {
    revokedSet = new Set();
  }
  return revokedSet;
}

function saveRevoked(set) {
  try {
    fs.writeFileSync(REVOKED_PATH(), JSON.stringify([...set].slice(-4096)), { mode: 0o600 });
  } catch (error) {
    console.error('[admin-session] 保存已撤销会话失败：', error.message);
  }
}

function revokeSessionToken(token) {
  if (typeof token !== 'string' || !token) return;
  const set = loadRevoked();
  set.add(crypto.createHash('sha256').update(token).digest('hex'));
  saveRevoked(set);
}

function isRevokedToken(token) {
  if (typeof token !== 'string' || !token) return false;
  return loadRevoked().has(crypto.createHash('sha256').update(token).digest('hex'));
}

let cachedSecret = null;

function sessionSecret() {
  if (cachedSecret !== null) return cachedSecret;
  const configured = String(process.env.SAKURA_AI_GATEWAY_ADMIN_SESSION_SECRET || '').trim();
  if (configured) {
    cachedSecret = configured;
    return configured;
  }
  const file = path.join(dataDir(), SECRET_FILENAME);
  try {
    if (fs.existsSync(file)) {
      const stored = fs.readFileSync(file, 'utf8').trim();
      if (stored.length >= 32) {
        cachedSecret = stored;
        return stored;
      }
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');
    fs.writeFileSync(file, generated, { mode: 0o600 });
    cachedSecret = generated;
    return generated;
  } catch (error) {
    console.error('[admin-session] 读取会话密钥失败：', error.message);
    cachedSecret = '';
    return '';
  }
}

function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 签发一枚管理会话令牌。
 * credentialVersion 为登录时的凭据快照（密码哈希摘要或 OIDC 客户端摘要），
 * 校验时与当前值比对，用于改密 / 改配置后让旧会话立即失效。
 * sessionEpoch 为账号会话纪元，停用或删除账号时递增，旧令牌随即失效。
 */
function createSessionToken({ mode, user, credentialVersion = '', originHost = '', sessionEpoch = 0, ttlSeconds = SESSION_TTL_SECONDS }) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('会话有效期必须是正整数秒');
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iat: now,
    exp: now + ttlSeconds,
    nonce: crypto.randomBytes(12).toString('hex'),
    mode,
    sub: String(user?.sub || ''),
    username: String(user?.username || ''),
    name: String(user?.name || ''),
    email: String(user?.email || ''),
    credentialVersion: String(credentialVersion || ''),
    originHost: String(originHost || ''),
    sessionEpoch: Number(sessionEpoch) || 0
  }));
  return `${payload}.${sign(payload)}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || token.length > 2048 || !TOKEN_PATTERN.test(token)) return null;
  if (isRevokedToken(token)) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot >= token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!sessionSecret()) return null;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object') return null;
    if (typeof decoded.exp !== 'number' || decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!['oidc', 'password'].includes(decoded.mode)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function sessionCookieOptions(maxAge = SESSION_TTL_SECONDS) {
  return { httpOnly: true, sameSite: 'lax', path: '/', maxAge };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
  revokeSessionToken,
  sessionCookieOptions
};
