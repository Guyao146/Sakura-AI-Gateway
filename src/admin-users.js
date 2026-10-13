const crypto = require('node:crypto');
const { makeId } = require('./config');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const PREFIX = 'scrypt';
const MAXMEM = 128 * 1024 * 1024;

const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;

function normalizeUsername(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validateUsername(value) {
  const username = normalizeUsername(value);
  if (username.length < USERNAME_MIN) throw new Error(`用户名至少 ${USERNAME_MIN} 个字符`);
  if (username.length > USERNAME_MAX) throw new Error(`用户名最多 ${USERNAME_MAX} 个字符`);
  if (!/^[A-Za-z0-9._@+-]+$/.test(username)) throw new Error('用户名只能包含字母、数字以及 . _ @ + -');
  return username;
}

function validatePassword(value) {
  const password = typeof value === 'string' ? value : '';
  if (password.length < PASSWORD_MIN) throw new Error(`密码至少 ${PASSWORD_MIN} 个字符`);
  if (password.length > PASSWORD_MAX) throw new Error(`密码最多 ${PASSWORD_MAX} 个字符`);
  if (/\s/.test(password)) throw new Error('密码不能包含空白字符');
  return password;
}

function hashPassword(password, salt = crypto.randomBytes(SALT_LENGTH)) {
  const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'hex');
  const derived = crypto.scryptSync(validatePassword(password), saltBuffer, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM
  });
  return [PREFIX, SCRYPT_N, SCRYPT_R, SCRYPT_P, saltBuffer.toString('hex'), derived.toString('hex')].join('$');
}

function parsePasswordHash(hash) {
  const parts = String(hash || '').split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const salt = parts[4];
  const expected = parts[5];
  if (!Number.isInteger(params.N) || !Number.isInteger(params.r) || !Number.isInteger(params.p)) return null;
  if (params.N < 2 || params.N > 2 ** 31 || !Number.isInteger(Math.log2(params.N)) || params.r < 1 || params.p < 1) return null;
  const saltBuffer = Buffer.from(salt, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (saltBuffer.length === 0 || expectedBuffer.length === 0) return null;
  return { params, saltBuffer, expectedBuffer };
}

function verifyPassword(password, hash) {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const candidate = crypto.scryptSync(String(password || ''), parsed.saltBuffer, parsed.expectedBuffer.length, {
    ...parsed.params,
    maxmem: MAXMEM
  });
  return candidate.length === parsed.expectedBuffer.length
    && crypto.timingSafeEqual(candidate, parsed.expectedBuffer);
}

function userSummary(user) {
  return {
    id: String(user?.id || ''),
    username: String(user?.username || ''),
    enabled: user?.enabled !== false,
    createdAt: user?.createdAt || null,
    updatedAt: user?.updatedAt || null
  };
}

function userFromBody(body, existing = null) {
  if (!body || typeof body !== 'object') throw new Error('请求体无效');
  const username = validateUsername(body.username ?? existing?.username);
  const id = existing?.id || makeId('admin');
  const now = new Date().toISOString();
  const passwordChanged = typeof body.password === 'string' && body.password.trim() !== '';
  if (!existing && !passwordChanged) throw new Error('新建管理员账号必须设置密码');
  let passwordHash = existing?.passwordHash || '';
  if (passwordChanged) passwordHash = hashPassword(body.password);
  if (!passwordHash) throw new Error('缺少密码');
  return {
    id,
    username,
    passwordHash,
    enabled: body.enabled === undefined ? (existing?.enabled !== false) : body.enabled !== false,
    sessionEpoch: Number.isFinite(Number(existing?.sessionEpoch)) && Number(existing.sessionEpoch) >= 0 ? Number(existing.sessionEpoch) : 0,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  parsePasswordHash,
  validateUsername,
  validatePassword,
  normalizeUsername,
  userFromBody,
  userSummary,
  USERNAME_MIN,
  USERNAME_MAX,
  PASSWORD_MIN,
  PASSWORD_MAX
};
