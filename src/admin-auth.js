const crypto = require('node:crypto');
const net = require('node:net');
const { verifyPassword } = require('./admin-users');
const { safeReturnTo } = require('../public/auth-utils');
const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  createSessionToken,
  verifySessionToken,
  revokeSessionToken
} = require('./admin-session');

const TRANSACTION_COOKIE = 'sakura_ai_gateway_oidc_state';
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 60;

function normalizeAddress(value) {
  let address = String(value || '').trim().toLowerCase();
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) address = address.slice(7);
  return net.isIP(address) ? address : '';
}

function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (address === '::1') return true;
  if (net.isIP(address) !== 4) return false;
  return Number(address.split('.')[0]) === 127;
}

function trustedProxySet(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(',');
  return new Set(entries.map(normalizeAddress).filter(Boolean));
}

function requestSource(req, trustedProxies = new Set()) {
  const socketAddress = normalizeAddress(req.socket?.remoteAddress);
  const hasForwardingHeaders = Boolean(req.headers?.['x-forwarded-for'] || req.headers?.forwarded);
  if (!socketAddress || !trustedProxies.has(socketAddress)) {
    if (isLoopbackAddress(socketAddress) && hasForwardingHeaders) {
      return { address: '', socketAddress, viaTrustedProxy: false, untrustedForwarding: true };
    }
    return { address: socketAddress, socketAddress, viaTrustedProxy: false, untrustedForwarding: false };
  }
  const forwarded = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizeAddress)
    .filter(Boolean);
  if (!forwarded.length) {
    if (!hasForwardingHeaders) return { address: socketAddress, socketAddress, viaTrustedProxy: false, untrustedForwarding: false };
    return { address: '', socketAddress, viaTrustedProxy: true, untrustedForwarding: true };
  }
  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    if (!trustedProxies.has(forwarded[index])) {
      return { address: forwarded[index], socketAddress, viaTrustedProxy: true, untrustedForwarding: false };
    }
  }
  return { address: forwarded[0], socketAddress, viaTrustedProxy: true, untrustedForwarding: false };
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

function base64urlJson(value) {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Authentik 返回了无效的 ID Token'), { statusCode: 502 });
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left || ''));
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right || ''));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function validateReturnTo(value) {
  return safeReturnTo(value);
}

function positiveInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function validHttpUrl(value, requiredPath = '') {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && (!requiredPath || url.pathname.endsWith(requiredPath));
  } catch {
    return false;
  }
}

function oidcError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

class AdminAuth {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.issuerUrl = String(options.issuerUrl ?? env.AUTHENTIK_ISSUER_URL ?? '').trim().replace(/\/+$/, '');
    this.clientId = String(options.clientId ?? env.AUTHENTIK_CLIENT_ID ?? '').trim();
    this.clientSecret = String(options.clientSecret ?? env.AUTHENTIK_CLIENT_SECRET ?? '');
    this.redirectUri = String(options.redirectUri ?? env.AUTHENTIK_REDIRECT_URI ?? '').trim();
    this.scopes = String(options.scopes ?? env.AUTHENTIK_SCOPES ?? 'openid profile email').trim() || 'openid profile email';
    this.tokenAuthMethod = String(options.tokenAuthMethod ?? env.AUTHENTIK_TOKEN_AUTH_METHOD ?? '').trim();
    this.sessionTtlSeconds = positiveInteger(options.sessionTtlSeconds ?? env.AUTHENTIK_SESSION_TTL_SECONDS, SESSION_TTL_SECONDS, 300, 7 * 24 * 60 * 60);
    this.trustedProxies = trustedProxySet(options.trustedProxies ?? env.TRUSTED_PROXY_ADDRESSES);
    this.fetch = options.fetch || globalThis.fetch;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    const redirectIsHttps = (() => {
      try { return new URL(this.redirectUri).protocol === 'https:'; } catch { return false; }
    })();
    const secureSetting = String(options.cookieSecure ?? env.AUTHENTIK_COOKIE_SECURE ?? '').toLowerCase();
    this.cookieSecure = secureSetting ? secureSetting !== 'false' && secureSetting !== '0' : redirectIsHttps;
    this.transactions = new Map();
    this.discoveryCache = null;
    this.jwksCache = null;
    this.getAdminAuth = typeof options.getAdminAuth === 'function' ? options.getAdminAuth : () => ({ users: [] });
    this.loginFailures = new Map();
  }

  localAuthConfig() {
    const value = this.getAdminAuth() || {};
    return {
      requireLocalLogin: value.requireLocalLogin === true,
      users: Array.isArray(value.users) ? value.users.filter((item) => item && item.id && item.username && item.passwordHash) : []
    };
  }

  requireLocalLogin() {
    return this.localAuthConfig().requireLocalLogin === true && (this.isPasswordConfigured() || this.isConfigured());
  }

  enabledLocalUsers() {
    return this.localAuthConfig().users.filter((item) => item.enabled !== false);
  }

  isPasswordConfigured() {
    return this.enabledLocalUsers().length > 0;
  }

  remoteConfigured() {
    return this.isPasswordConfigured() || this.isConfigured();
  }

  remoteConfigurationError() {
    if (this.remoteConfigured()) return '';
    return [this.configurationError(), '还没有可用的本地管理员账号；请在本机回环访问后台创建'].filter(Boolean).join('；');
  }

  failureKey(req) {
    const source = this.source(req);
    return normalizeAddress(source.address) || normalizeAddress(source.socketAddress) || 'unknown';
  }

  checkLoginLockout(req) {
    const key = this.failureKey(req);
    const entry = this.loginFailures.get(key);
    if (!entry || !entry.lockedUntil || entry.lockedUntil <= Date.now()) return null;
    const seconds = Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 1000));
    const error = new Error(`登录尝试过于频繁，请 ${seconds} 秒后再试`);
    error.statusCode = 429;
    error.retryAfter = seconds;
    return error;
  }

  recordLoginFailure(req) {
    const key = this.failureKey(req);
    const now = Date.now();
    const windowMs = 5 * 60 * 1000;
    const entry = this.loginFailures.get(key);
    if (!entry || now - entry.firstAt > windowMs) {
      this.loginFailures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
      return 1;
    }
    entry.count += 1;
    if (entry.count >= 5 && entry.lockedUntil <= now) entry.lockedUntil = now + 60 * 1000;
    return entry.count;
  }

  clearLoginFailures(req) {
    this.loginFailures.delete(this.failureKey(req));
  }

  async loginWithPassword(req, credentials = {}) {
    if (!this.isPasswordConfigured()) {
      const error = new Error('还没有可用的本地管理员账号，无法使用账号密码登录');
      error.statusCode = 503;
      throw error;
    }
    const locked = this.checkLoginLockout(req);
    if (locked) throw locked;
    const username = String(credentials.username || '');
    const password = String(credentials.password || '');
    const candidates = this.enabledLocalUsers();
    const user = candidates.find((item) => safeEqual(item.username, username)) || null;
    if (!user || !verifyPassword(password, user.passwordHash)) {
      this.recordLoginFailure(req);
      const error = new Error('用户名或密码错误');
      error.statusCode = 401;
      throw error;
    }
    this.clearLoginFailures(req);
    const userClaims = {
      sub: `local:${user.id}`,
      username: user.username,
      name: user.username,
      email: ''
    };
    const credentialVersion = crypto.createHash('sha256').update(user.passwordHash).digest('hex');
    const sessionToken = createSessionToken({
      mode: 'password',
      user: userClaims,
      credentialVersion,
      originHost: String(req.headers.host || '').toLowerCase(),
      sessionEpoch: Number(user.sessionEpoch) || 0,
      ttlSeconds: this.sessionTtlSeconds
    });
    this.log('管理员已登录（本地账号）', { username: user.username, source: 'password' });
    return {
      user: userClaims,
      cookie: this.cookie(SESSION_COOKIE, sessionToken, this.sessionTtlSeconds)
    };
  }

  localUsersSummary() {
    return {
      requireLocalLogin: this.localAuthConfig().requireLocalLogin === true,
      oidcConfigured: this.isConfigured(),
      users: this.localAuthConfig().users.map((item) => ({
        id: String(item.id || ''),
        username: String(item.username || ''),
        enabled: item.enabled !== false,
        createdAt: item.createdAt || null,
        updatedAt: item.updatedAt || null
      }))
    };
  }

  isConfigured() {
    return Boolean(
      this.clientId
      && this.clientSecret
      && validHttpUrl(this.issuerUrl)
      && validHttpUrl(this.redirectUri, '/auth/oidc/callback')
    );
  }

  configurationError() {
    if (this.isConfigured()) return '';
    const missing = [];
    if (!this.issuerUrl) missing.push('AUTHENTIK_ISSUER_URL');
    if (!this.clientId) missing.push('AUTHENTIK_CLIENT_ID');
    if (!this.clientSecret) missing.push('AUTHENTIK_CLIENT_SECRET');
    if (!this.redirectUri) missing.push('AUTHENTIK_REDIRECT_URI');
    const invalid = [];
    if (this.issuerUrl && !validHttpUrl(this.issuerUrl)) invalid.push('AUTHENTIK_ISSUER_URL 格式无效');
    if (this.redirectUri && !validHttpUrl(this.redirectUri, '/auth/oidc/callback')) invalid.push('AUTHENTIK_REDIRECT_URI 必须是以 /auth/oidc/callback 结尾的 HTTP(S) URL');
    return `远程管理访问尚未正确配置 Authentik OIDC：${[missing.length ? `缺少 ${missing.join('、')}` : '', ...invalid].filter(Boolean).join('；')}`;
  }

  source(req) {
    return requestSource(req, this.trustedProxies);
  }

  isLocal(req) {
    return isLoopbackAddress(this.source(req).address);
  }

  cleanup() {
    const now = Date.now();
    for (const [state, transaction] of this.transactions) if (transaction.expiresAt <= now) this.transactions.delete(state);
  }

  // 无状态签名令牌：校验签名与有效期，再按登录方式核对当前凭据版本。
  sessionForRequest(req) {
    const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    const claims = verifySessionToken(token);
    if (!claims) return null;
    if (claims.mode === 'password') {
      const user = this.enabledLocalUsers().find((item) => `local:${item.id}` === claims.sub);
      if (!user) return null;
      const credentialVersion = crypto.createHash('sha256').update(user.passwordHash).digest('hex');
      if (claims.credentialVersion !== credentialVersion) return null;
      if (Number(claims.sessionEpoch || 0) !== Number(user.sessionEpoch || 0)) return null;
    } else if (claims.mode === 'oidc') {
      if (!this.isConfigured()) return null;
      const credentialVersion = crypto.createHash('sha256').update(`${this.issuerUrl}:${this.clientId}`).digest('hex');
      if (claims.credentialVersion !== credentialVersion) return null;
    } else {
      return null;
    }
    return {
      id: token,
      mode: claims.mode,
      user: { sub: claims.sub, username: claims.username, name: claims.name, email: claims.email },
      originHost: claims.originHost || '',
      expiresAt: claims.exp * 1000,
      createdAt: claims.iat * 1000
    };
  }

  authenticate(req, { requireAccount = false } = {}) {
    const source = this.source(req);
    if (!requireAccount && isLoopbackAddress(source.address) && !this.requireLocalLogin()) {
      return { ok: true, mode: 'local', source, configured: this.remoteConfigured() };
    }
    const session = this.sessionForRequest(req);
    if (session) return { ok: true, mode: session.mode || 'oidc', source, session, user: session.user, configured: this.remoteConfigured() };
    return { ok: false, mode: '', source, configured: this.remoteConfigured(), localLoginRequired: this.requireLocalLogin() };
  }

  async fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      const raw = await response.text();
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { throw oidcError(`Authentik 返回了非 JSON 响应（HTTP ${response.status}）`); }
      if (!response.ok) {
        const message = body.error_description || body.error?.message || body.error || `HTTP ${response.status}`;
        throw oidcError(`Authentik 请求失败：${message}`);
      }
      return body;
    } catch (error) {
      if (error.name === 'AbortError') throw oidcError('连接 Authentik 超时');
      if (error.statusCode) throw error;
      throw oidcError(`无法连接 Authentik：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async discovery() {
    if (!this.isConfigured()) throw oidcError(this.configurationError(), 503);
    if (this.discoveryCache?.expiresAt > Date.now()) return this.discoveryCache.value;
    const discoveryUrl = `${this.issuerUrl}/.well-known/openid-configuration`;
    // 发现文档不可达时回落到约定路径；非约定部署必须提供发现文档。
    const fallback = {
      issuer: this.issuerUrl,
      authorization_endpoint: `${this.issuerUrl}/authorize`,
      token_endpoint: `${this.issuerUrl}/token`,
      userinfo_endpoint: `${this.issuerUrl}/userinfo`
    };
    let value;
    try {
      value = await this.fetchJson(discoveryUrl);
    } catch (error) {
      this.log('Authentik discovery 不可达，回落到约定端点', { message: error.message });
      value = fallback;
    }
    if (!value || typeof value !== 'object') value = fallback;
    const issuerMatches = String(value.issuer || '').replace(/\/+$/, '') === this.issuerUrl;
    if (!issuerMatches || !value.authorization_endpoint || !value.token_endpoint) {
      throw oidcError('Authentik OIDC discovery 响应缺少必要端点或 issuer 不匹配');
    }
    this.discoveryCache = { value, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return value;
  }

  cookie(name, value, maxAge, path = '/') {
    const parts = [
      `${name}=${encodeURIComponent(value)}`,
      `Path=${path}`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.max(0, Math.floor(maxAge))}`
    ];
    if (this.cookieSecure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie(name, path = '/') {
    return this.cookie(name, '', 0, path);
  }

  async beginLogin(returnTo = '/') {
    const discovery = await this.discovery();
    this.cleanup();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(48).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    this.transactions.set(state, {
      nonce,
      codeVerifier,
      returnTo: validateReturnTo(returnTo),
      expiresAt: Date.now() + TRANSACTION_TTL_MS
    });
    const authorizationUrl = new URL(discovery.authorization_endpoint);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', this.clientId);
    authorizationUrl.searchParams.set('redirect_uri', this.redirectUri);
    authorizationUrl.searchParams.set('scope', this.scopes);
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    return {
      location: authorizationUrl.toString(),
      cookie: this.cookie(TRANSACTION_COOKIE, state, TRANSACTION_TTL_MS / 1000, '/auth/oidc/callback')
    };
  }

  async jwks(discovery, force = false) {
    if (!force && this.jwksCache?.uri === discovery.jwks_uri && this.jwksCache.expiresAt > Date.now()) return this.jwksCache.value;
    const value = await this.fetchJson(discovery.jwks_uri);
    if (!Array.isArray(value.keys)) throw oidcError('Authentik JWKS 响应无效');
    this.jwksCache = { uri: discovery.jwks_uri, value, expiresAt: Date.now() + DISCOVERY_TTL_MS };
    return value;
  }

  async verifyIdToken(idToken, expectedNonce, discovery) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw oidcError('Authentik 未返回有效的 ID Token');
    const header = base64urlJson(parts[0]);
    const claims = base64urlJson(parts[1]);
    const signature = Buffer.from(parts[2], 'base64url');
    const signedData = Buffer.from(`${parts[0]}.${parts[1]}`);
    const algorithm = String(header.alg || '');
    if (!algorithm || algorithm === 'none') throw oidcError('Authentik ID Token 使用了不安全的签名算法');
    if (Array.isArray(discovery.id_token_signing_alg_values_supported) && !discovery.id_token_signing_alg_values_supported.includes(algorithm)) {
      throw oidcError(`Authentik ID Token 使用了 discovery 未声明的签名算法：${algorithm}`);
    }

    let verified = false;
    const hmacAlgorithms = { HS256: 'sha256', HS384: 'sha384', HS512: 'sha512' };
    if (hmacAlgorithms[algorithm]) {
      const expected = crypto.createHmac(hmacAlgorithms[algorithm], this.clientSecret).update(signedData).digest();
      verified = safeEqual(signature, expected);
    } else {
      let keys = await this.jwks(discovery);
      let jwk = keys.keys.find((item) => !header.kid || item.kid === header.kid);
      if (!jwk && header.kid) {
        keys = await this.jwks(discovery, true);
        jwk = keys.keys.find((item) => item.kid === header.kid);
      }
      if (!jwk) throw oidcError('Authentik JWKS 中找不到 ID Token 的签名密钥');
      let publicKey;
      try { publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' }); } catch { throw oidcError('Authentik JWKS 包含无效公钥'); }
      const algorithms = {
        RS256: ['RSA-SHA256', {}], RS384: ['RSA-SHA384', {}], RS512: ['RSA-SHA512', {}],
        PS256: ['RSA-SHA256', { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }],
        PS384: ['RSA-SHA384', { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }],
        PS512: ['RSA-SHA512', { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }],
        ES256: ['sha256', { dsaEncoding: 'ieee-p1363' }], ES384: ['sha384', { dsaEncoding: 'ieee-p1363' }], ES512: ['sha512', { dsaEncoding: 'ieee-p1363' }],
        EdDSA: [null, {}]
      };
      const verifier = algorithms[algorithm];
      if (!verifier) throw oidcError(`暂不支持 Authentik ID Token 签名算法：${algorithm}`);
      verified = crypto.verify(verifier[0], signedData, { key: publicKey, ...verifier[1] }, signature);
    }
    if (!verified) throw oidcError('Authentik ID Token 签名校验失败');

    const now = Math.floor(Date.now() / 1000);
    if (String(claims.iss || '') !== String(discovery.issuer || '')) throw oidcError('Authentik ID Token issuer 不匹配');
    const audiences = Array.isArray(claims.aud) ? claims.aud.map(String) : [String(claims.aud || '')];
    if (!audiences.includes(this.clientId)) throw oidcError('Authentik ID Token audience 不匹配');
    if (audiences.length > 1 && claims.azp !== this.clientId) throw oidcError('Authentik ID Token azp 不匹配');
    if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) < now - CLOCK_TOLERANCE_SECONDS) throw oidcError('Authentik ID Token 已过期');
    if (claims.nbf !== undefined && Number(claims.nbf) > now + CLOCK_TOLERANCE_SECONDS) throw oidcError('Authentik ID Token 尚未生效');
    if (claims.iat !== undefined && Number(claims.iat) > now + CLOCK_TOLERANCE_SECONDS) throw oidcError('Authentik ID Token 签发时间无效');
    if (!expectedNonce || !safeEqual(claims.nonce, expectedNonce)) throw oidcError('Authentik ID Token nonce 不匹配');
    if (!claims.sub) throw oidcError('Authentik ID Token 缺少用户标识');
    return claims;
  }

  async finishLogin(params, cookieHeader, req = null) {
    this.cleanup();
    if (params.error) throw oidcError(`Authentik 登录失败：${params.error_description || params.error}`, 401);
    const state = String(params.state || '');
    const cookieState = parseCookies(cookieHeader)[TRANSACTION_COOKIE];
    const transaction = this.transactions.get(state);
    if (!state || !cookieState || !safeEqual(state, cookieState) || !transaction) throw oidcError('OIDC 登录状态无效或已过期', 401);
    this.transactions.delete(state);
    if (!params.code) throw oidcError('Authentik 回调缺少授权码', 400);
    const discovery = await this.discovery();
    const tokens = await this.exchangeCode(params.code, transaction.codeVerifier, discovery);
    // 返回 ID Token 时必须先校验签名、issuer/audience、有效期和 nonce，
    // userinfo 仅提供优先展示的资料，不能绕过身份验证或替换登录主体。
    const idClaims = tokens.id_token !== undefined
      ? await this.verifyIdToken(tokens.id_token, transaction.nonce, discovery) : null;
    let claims = null;
    if (discovery.userinfo_endpoint && tokens.access_token) {
      try {
        claims = await this.fetchUserInfo(tokens.access_token, discovery);
      } catch (error) {
        this.log('Authentik userinfo 获取失败，回落到 ID Token', { message: error.message });
      }
    }
    if (claims && idClaims && claims.sub !== idClaims.sub) throw oidcError('Authentik userinfo 与 ID Token 的 sub 不匹配');
    if (!claims) {
      if (!idClaims) throw oidcError('Authentik 未返回可用的用户信息');
      claims = idClaims;
    }
    const user = {
      sub: String(claims.sub),
      username: String(claims.preferred_username || claims.nickname || claims.email || claims.name || claims.sub),
      name: String(claims.name || claims.preferred_username || claims.email || ''),
      email: String(claims.email || '')
    };
    const credentialVersion = crypto.createHash('sha256').update(`${this.issuerUrl}:${this.clientId}`).digest('hex');
    const sessionToken = createSessionToken({
      mode: 'oidc',
      user,
      credentialVersion,
      originHost: String(req?.headers?.host || '').toLowerCase(),
      ttlSeconds: this.sessionTtlSeconds
    });
    this.log('Authentik 管理员已登录', { username: user.username, source: 'oidc' });
    return {
      returnTo: transaction.returnTo,
      cookies: [
        this.cookie(SESSION_COOKIE, sessionToken, this.sessionTtlSeconds),
        this.clearCookie(TRANSACTION_COOKIE, '/auth/oidc/callback')
      ]
    };
  }

  // 用授权码换取令牌；PKCE 校验由 IdP 负责，这里只携带 code_verifier。
  async exchangeCode(code, codeVerifier, discovery) {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code || ''),
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: codeVerifier
    });
    const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
    const supportedMethods = Array.isArray(discovery.token_endpoint_auth_methods_supported) ? discovery.token_endpoint_auth_methods_supported : [];
    let authMethod = this.tokenAuthMethod;
    if (!authMethod) {
      if (!supportedMethods.length || supportedMethods.includes('client_secret_basic')) authMethod = 'client_secret_basic';
      else if (supportedMethods.includes('client_secret_post')) authMethod = 'client_secret_post';
      else throw oidcError('Authentik discovery 未声明可用的 Client Secret 鉴权方式');
    }
    if (supportedMethods.length && !supportedMethods.includes(authMethod)) {
      throw oidcError(`Authentik discovery 不支持配置的 Token 鉴权方式：${authMethod}`);
    }
    if (authMethod === 'client_secret_post') form.set('client_secret', this.clientSecret);
    else if (authMethod === 'client_secret_basic') {
      const credentials = `${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`;
      headers.Authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else {
      throw oidcError(`不支持的 Authentik Token 鉴权方式：${authMethod}`);
    }
    const tokens = await this.fetchJson(discovery.token_endpoint, { method: 'POST', headers, body: form.toString() });
    if (typeof tokens.access_token !== 'string' || !tokens.access_token) {
      throw oidcError('Authentik 未返回有效的访问令牌');
    }
    return tokens;
  }

  // 用访问令牌拉取用户信息；以 sub 为身份标识。
  async fetchUserInfo(accessToken, discovery) {
    const payload = await this.fetchJson(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    if (!payload || typeof payload !== 'object' || typeof payload.sub !== 'string' || !payload.sub) {
      throw oidcError('Authentik 返回的用户信息缺少 sub');
    }
    return payload;
  }

  logout(req) {
    // 本地注销：撤销令牌指纹并清 cookie，退出后回到登录页。
    // 签名令牌本身无状态，需把指纹记入撤销表，下次校验即拒绝。
    const token = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
    if (token) revokeSessionToken(token);
    return { location: '/auth/login', cookie: this.clearCookie(SESSION_COOKIE) };
  }
}

function createAdminAuth(options) {
  return new AdminAuth(options);
}

module.exports = {
  AdminAuth,
  createAdminAuth,
  SESSION_COOKIE,
  isLoopbackAddress,
  normalizeAddress,
  parseCookies,
  requestSource,
  trustedProxySet
};