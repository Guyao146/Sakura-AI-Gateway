const crypto = require('node:crypto');
const { hashToken } = require('./integration');
const { normalizeKeyAccess, keyAccessModels, isKeyModelAllowed } = require('../public/key-access');

const ACCESS_TOKEN_PREFIX = 'sakura-at_';
const REFRESH_TOKEN_PREFIX = 'sakura-rt_';
const AUTO_CLIENT_ID = 'auto';
const SCOPES = Object.freeze({
  'models:read': '读取获准使用的模型列表与接入配置',
  'models:invoke': '调用获准使用的模型（会消耗上游额度）',
  offline_access: '保持连接，在授权有效期内刷新访问令牌'
});
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CONSENT_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 1000;
const MAX_REFRESH_HISTORY = 1024;
const random = (prefix = '') => prefix + crypto.randomBytes(32).toString('base64url');
const iso = (time) => new Date(time).toISOString();

function oauthError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { oauthCode: code, statusCode });
}

function scopesFrom(value = 'models:read models:invoke') {
  if (typeof value !== 'string' || value.length > 200) throw oauthError('invalid_scope', '授权范围无效');
  const scopes = [...new Set(value.trim().split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !Object.hasOwn(SCOPES, scope)) || !scopes.some((scope) => scope !== 'offline_access')) {
    throw oauthError('invalid_scope', '只支持 models:read、models:invoke 和 offline_access，且必须包含一种模型权限');
  }
  return scopes;
}

function validateRedirectUri(value) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//.test(value) || /[\s\\#*]/.test(value)) {
    throw oauthError('invalid_request', '回调地址必须是完整的 HTTPS URL（本机回环允许 HTTP），不能含通配符或片段');
  }
  let url;
  try { url = new URL(value); } catch { throw oauthError('invalid_request', '回调地址格式无效'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw oauthError('invalid_request', '回调地址不允许凭据，非回环地址必须使用 HTTPS');
  }
  if (['code', 'state', 'error', 'error_description', 'iss'].some((key) => url.searchParams.has(key))) {
    throw oauthError('invalid_request', '回调地址不能预设 OAuth 响应参数');
  }
  // 保存原字符串，授权和换码时逐字符匹配，不放宽路径、端口或查询参数。
  return value;
}

function normalizeOAuthClient(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw oauthError('invalid_request', '应用配置必须是对象');
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  if (!name || name.length > 100) throw oauthError('invalid_request', '应用名称需要 1 到 100 个字符');
  if (!Array.isArray(item.redirectUris) || !item.redirectUris.length || item.redirectUris.length > 10) {
    throw oauthError('invalid_request', '请登记 1 到 10 个准确的回调地址');
  }
  const sourceKeyId = typeof item.sourceKeyId === 'string' ? item.sourceKeyId.trim() : '';
  if (!sourceKeyId || sourceKeyId.length > 120) throw oauthError('invalid_request', '请选择来源 Key 作为应用权限上限');
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw oauthError('invalid_request', 'enabled 必须是布尔值');
  if (String(item.id || '') === AUTO_CLIENT_ID) throw oauthError('invalid_request', '应用 ID 不能使用保留字 auto');
  const id = String(item.id || random('oauth_client_'));
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) throw oauthError('invalid_request', '应用 ID 无效');
  return {
    id, name, sourceKeyId,
    redirectUris: [...new Set(item.redirectUris.map(validateRedirectUri))],
    enabled: item.enabled !== false,
    revision: String(item.revision || random()),
    createdAt: item.createdAt || iso(Date.now()),
    updatedAt: item.updatedAt || iso(Date.now())
  };
}

function normalizeOAuthGrant(item) {
  if (!item || typeof item !== 'object' || !item.id || !item.clientId || !item.sourceKeyId || !item.clientRevision
    || !['active', 'cancelled'].includes(item.status) || !['password', 'oidc'].includes(item.subject?.mode)
    || typeof item.subject.id !== 'string' || !item.subject.id || !/^[a-f0-9]{64}$/.test(item.subject.credentialVersion || '')
    || !Array.isArray(item.scopes) || !item.scopes.length || item.scopes.some((scope) => typeof scope !== 'string' || !Object.hasOwn(SCOPES, scope))
    || !item.keyAccess || !['all', 'custom'].includes(item.keyAccess.modelAccessMode)
    || !/^[a-f0-9]{64}$/.test(item.accessTokenHash || '')
    || !Number.isFinite(Date.parse(item.accessExpiresAt)) || !Number.isFinite(Date.parse(item.expiresAt))) {
    throw oauthError('invalid_request', '账号授权记录格式无效');
  }
  const refreshHash = item.refreshTokenHash || '';
  const usedRefreshHashes = item.usedRefreshHashes || [];
  if ((refreshHash && !/^[a-f0-9]{64}$/.test(refreshHash)) || !Array.isArray(usedRefreshHashes)
    || usedRefreshHashes.length > MAX_REFRESH_HISTORY || usedRefreshHashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw oauthError('invalid_request', '刷新令牌记录格式无效');
  }
  return {
    id: String(item.id), clientId: String(item.clientId), clientRevision: String(item.clientRevision), sourceKeyId: String(item.sourceKeyId),
    subject: { id: item.subject.id, mode: item.subject.mode, username: String(item.subject.username || ''), issuer: String(item.subject.issuer || ''), credentialVersion: String(item.subject.credentialVersion || '') },
    scopes: scopesFrom(item.scopes.join(' ')),
    keyAccess: normalizeKeyAccess(item.keyAccess),
    status: item.status, createdAt: item.createdAt || item.accessExpiresAt,
    expiresAt: item.expiresAt, accessExpiresAt: item.accessExpiresAt,
    accessTokenHash: item.accessTokenHash, refreshTokenHash: refreshHash, usedRefreshHashes: [...usedRefreshHashes],
    cancelledAt: item.cancelledAt || null, cancelReason: String(item.cancelReason || '').slice(0, 200)
  };
}

function normalizeOAuthState(config = {}) {
  const normalizeList = (value, normalize) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw oauthError('invalid_request', 'OAuth 配置列表格式无效');
    const items = value.map(normalize);
    if (new Set(items.map((item) => item.id)).size !== items.length) throw oauthError('invalid_request', 'OAuth 配置存在重复 ID');
    return items;
  };
  return {
    oauthClients: normalizeList(config.oauthClients, normalizeOAuthClient),
    oauthGrants: normalizeList(config.oauthGrants, normalizeOAuthGrant)
  };
}

function oauthClientPublic(client) {
  const { revision, ...result } = client;
  return { ...result, redirectUris: [...client.redirectUris] };
}

class OAuthProvider {
  constructor({ getConfig, save, isSubjectActive, now = Date.now }) {
    this.getConfig = getConfig;
    this.save = save;
    this.isSubjectActive = isSubjectActive;
    this.now = now;
    this.consents = new Map();
    this.codes = new Map();
  }

  cleanup() {
    for (const store of [this.consents, this.codes]) {
      for (const [key, value] of store) if (value.expiresAt <= this.now()) store.delete(key);
    }
  }

  client(id, enabled = true) {
    const client = this.getConfig().oauthClients.find((item) => item.id === id && (!enabled || item.enabled));
    if (!client) throw oauthError('invalid_client', '应用不存在或已停用');
    return client;
  }

  sourceKey(client) {
    const key = this.getConfig().localApiKeys.find((item) => item.id === client.sourceKeyId && item.enabled !== false);
    if (!key) throw oauthError('access_denied', '应用的来源 Key 已停用或删除', 403);
    return key;
  }

  validateAutoAuthorization(parameters, issuer) {
    // 首次连接：接入方尚未登记 Client，由当前登录账号在确认授权时选择来源 Key 并自动登记。
    const name = typeof parameters.name === 'string' ? parameters.name.trim() : '';
    if (!name || name.length > 100) throw oauthError('invalid_request', '自动登记需要 1 到 100 字符的应用名称');
    const redirectUri = validateRedirectUri(parameters.redirect_uri);
    // Cookie 按主机而非端口隔离；同主机名回调会把管理会话一并发给接入应用。
    const hostname = (value) => new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    if (issuer && hostname(redirectUri) === hostname(issuer)) {
      throw oauthError('invalid_request', '应用回调不能与网关使用同一主机名（即使端口不同），请使用独立域名；本机可分别使用 localhost 与 127.0.0.1');
    }
    if (parameters.response_type !== 'code') throw oauthError('unsupported_response_type', '只支持授权码模式 response_type=code');
    if (parameters.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(parameters.code_challenge || '')) {
      throw oauthError('invalid_request', '必须提供 S256 PKCE code_challenge');
    }
    if (typeof parameters.state !== 'string' || !parameters.state || parameters.state.length > 512 || /[\u0000-\u001f\u007f]/.test(parameters.state)) {
      throw oauthError('invalid_request', '必须提供不超过 512 字符的随机 state');
    }
    const keys = this.getConfig().localApiKeys.filter((item) => item.enabled !== false);
    if (!keys.length) throw oauthError('access_denied', '网关还没有启用的本地调用 Key，无法自动登记应用', 403);
    const key = typeof parameters.key_id === 'string' && parameters.key_id
      ? keys.find((item) => item.id === parameters.key_id)
      : keys[0];
    if (!key) throw oauthError('invalid_request', '指定的来源 Key 不存在或已停用');
    return { auto: true, name, key, redirectUri, state: parameters.state, challenge: parameters.code_challenge, scopes: scopesFrom(parameters.scope) };
  }

  validateAuthorization(parameters, issuer) {
    if (parameters.client_id === AUTO_CLIENT_ID) return this.validateAutoAuthorization(parameters, issuer);
    const client = this.client(parameters.client_id);
    if (typeof parameters.redirect_uri !== 'string' || !client.redirectUris.includes(parameters.redirect_uri)) {
      throw oauthError('invalid_request', 'redirect_uri 与登记的回调地址不完全一致');
    }
    // Cookie 按主机而非端口隔离；同主机名回调会把管理会话一并发给接入应用。
    const hostname = (value) => new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    if (issuer && hostname(parameters.redirect_uri) === hostname(issuer)) {
      throw oauthError('invalid_request', '应用回调不能与网关使用同一主机名（即使端口不同），请使用独立域名；本机可分别使用 localhost 与 127.0.0.1');
    }
    if (parameters.response_type !== 'code') throw oauthError('unsupported_response_type', '只支持授权码模式 response_type=code');
    if (parameters.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(parameters.code_challenge || '')) {
      throw oauthError('invalid_request', '必须提供 S256 PKCE code_challenge');
    }
    if (typeof parameters.state !== 'string' || !parameters.state || parameters.state.length > 512 || /[\u0000-\u001f\u007f]/.test(parameters.state)) {
      throw oauthError('invalid_request', '必须提供不超过 512 字符的随机 state');
    }
    const key = this.sourceKey(client);
    return { client, key, redirectUri: parameters.redirect_uri, state: parameters.state, challenge: parameters.code_challenge, scopes: scopesFrom(parameters.scope) };
  }

  createConsent(parameters, sessionId, subject, issuer) {
    this.cleanup();
    if (this.consents.size >= MAX_PENDING) throw oauthError('temporarily_unavailable', '待确认的授权过多，请稍后重试', 503);
    if (!sessionId || !this.isSubjectActive(subject)) throw oauthError('access_denied', '账号已失效，请重新登录', 403);
    const { client, key, ...request } = this.validateAuthorization(parameters, issuer);
    const auto = Boolean(request.auto);
    const id = random('consent_');
    const csrfToken = random();
    const keyAccess = normalizeKeyAccess(key);
    this.consents.set(id, {
      ...request, autoName: auto ? request.name : undefined,
      clientId: auto ? AUTO_CLIENT_ID : client.id, clientRevision: auto ? '' : client.revision, sourceKeyId: key.id,
      keyAccess, subject: { ...subject }, sessionHash: hashToken(sessionId), csrfHash: hashToken(csrfToken), issuer,
      expiresAt: this.now() + CONSENT_TTL_MS
    });
    const catalog = keyAccessModels(this.getConfig());
    const models = catalog.filter((model) => isKeyModelAllowed(key, model.id, this.getConfig(), catalog));
    return {
      request_id: id, csrf_token: csrfToken, expires_in: CONSENT_TTL_MS / 1000,
      auto,
      client: auto ? { name: request.name, redirectUri: request.redirectUri } : { id: client.id, name: client.name, redirectUri: request.redirectUri },
      user: { username: subject.username }, sourceKey: { id: key.id, name: key.name },
      sourceKeys: auto ? this.getConfig().localApiKeys.filter((item) => item.enabled !== false).map((item) => ({ id: item.id, name: item.name })) : undefined,
      scopes: request.scopes.map((id) => ({ id, description: SCOPES[id] })),
      modelAccessMode: keyAccess.modelAccessMode, models: models.map(({ id }) => id)
    };
  }

  decideConsent(body, sessionId, subject, issuer) {
    this.cleanup();
    const pending = this.consents.get(body.request_id);
    if (!pending || pending.sessionHash !== hashToken(sessionId) || pending.csrfHash !== hashToken(body.csrf_token)
      || pending.subject.id !== subject?.id || pending.subject.mode !== subject?.mode || pending.issuer !== issuer) {
      throw oauthError('invalid_request', '授权确认已过期或不属于当前会话，请重新发起授权', 403);
    }
    if (typeof body.approve !== 'boolean') throw oauthError('invalid_request', '请明确选择允许或拒绝授权');
    const auto = Boolean(pending.autoName);
    let client = null;
    if (auto) {
      // 首次连接：由当前登录账号选择来源 Key，按精确回调地址自动登记或复用应用。
      const key = this.getConfig().localApiKeys.find((item) => item.id === String(body.source_key_id || '') && item.enabled !== false);
      if (!key) throw oauthError('invalid_request', '请选择有效的来源 Key');
      const existing = this.getConfig().oauthClients.find((item) => item.enabled !== false && item.redirectUris.includes(pending.redirectUri));
      client = this.saveClient({ name: pending.autoName, redirectUris: [pending.redirectUri], sourceKeyId: key.id }, existing?.id || '');
      pending.clientId = client.id;
      // saveClient 返回不含 revision 的公开视图；挂载授权码时需要实际版本号。
      pending.clientRevision = this.client(client.id).revision;
      pending.sourceKeyId = key.id;
      pending.keyAccess = normalizeKeyAccess(key);
    } else {
      client = this.client(pending.clientId);
      if (client.revision !== pending.clientRevision || !this.isSubjectActive(pending.subject)) throw oauthError('access_denied', '应用或账号已变更，请重新授权', 403);
      this.sourceKey(client);
    }
    if (!this.isSubjectActive(pending.subject)) throw oauthError('access_denied', '账号已变更，请重新授权', 403);
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set('state', pending.state);
    redirect.searchParams.set('iss', issuer);
    if (body.approve) {
      if (this.codes.size >= MAX_PENDING) throw oauthError('temporarily_unavailable', '待兑换的授权码过多，请稍后重试', 503);
      const code = random('sakura-code_');
      this.codes.set(hashToken(code), { ...pending, expiresAt: this.now() + CODE_TTL_MS });
      redirect.searchParams.set('code', code);
    } else {
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('error_description', '用户拒绝了授权');
    }
    this.consents.delete(body.request_id);
    return { redirect: redirect.toString() };
  }

  validGrant(grant) {
    if (!grant || grant.status !== 'active' || Date.parse(grant.expiresAt) <= this.now() || !this.isSubjectActive(grant.subject)) return false;
    const client = this.getConfig().oauthClients.find((item) => item.id === grant.clientId);
    return Boolean(client?.enabled && client.revision === grant.clientRevision && client.sourceKeyId === grant.sourceKeyId
      && this.getConfig().localApiKeys.some((key) => key.id === grant.sourceKeyId && key.enabled !== false));
  }

  effectiveKey(grant) {
    const config = this.getConfig();
    const key = config.localApiKeys.find((item) => item.id === grant.sourceKeyId);
    const current = normalizeKeyAccess(key);
    let access = current;
    if (current.modelAccessMode !== 'all' || grant.keyAccess.modelAccessMode !== 'all') {
      const catalog = keyAccessModels(config);
      const models = catalog.filter((model) => isKeyModelAllowed(current, model.id, config, catalog) && isKeyModelAllowed(grant.keyAccess, model.id, config, catalog));
      access = { modelAccessMode: 'custom', allowedModels: models.map(({ id }) => id), allowedGroups: [...new Set(models.map(({ group }) => group))] };
    }
    // 不返回来源 Key 的明文；配额仍归属于来源 Key，不能靠重复授权绕过限流。
    return { id: key.id, name: key.name, enabled: true, ...access };
  }

  authenticate(token, requiredScope) {
    if (typeof token !== 'string' || !token.startsWith(ACCESS_TOKEN_PREFIX) || token.length > 128) throw oauthError('invalid_token', '访问令牌无效', 401);
    const hash = hashToken(token);
    const grant = this.getConfig().oauthGrants.find((item) => item.accessTokenHash === hash);
    if (!this.validGrant(grant) || Date.parse(grant.accessExpiresAt) <= this.now()) throw oauthError('invalid_token', '访问令牌已过期、已撤销或账号权限已失效', 401);
    if (requiredScope && !grant.scopes.includes(requiredScope)) throw oauthError('insufficient_scope', `授权缺少 ${requiredScope} 权限`, 403);
    return { grant, key: this.effectiveKey(grant) };
  }

  issueTokens(grant, previousRefreshHash = '') {
    const accessToken = random(ACCESS_TOKEN_PREFIX);
    const refreshToken = grant.scopes.includes('offline_access') ? random(REFRESH_TOKEN_PREFIX) : '';
    const accessExpiresAt = Math.min(this.now() + ACCESS_TTL_MS, Date.parse(grant.expiresAt));
    const next = {
      ...grant, accessTokenHash: hashToken(accessToken), accessExpiresAt: iso(accessExpiresAt),
      expiresAt: refreshToken ? grant.expiresAt : iso(accessExpiresAt),
      refreshTokenHash: refreshToken ? hashToken(refreshToken) : '',
      usedRefreshHashes: previousRefreshHash ? [...grant.usedRefreshHashes, previousRefreshHash] : []
    };
    const config = this.getConfig();
    const previous = config.oauthGrants;
    config.oauthGrants = [...previous.filter((item) => item.id !== grant.id), next];
    try { this.save(); } catch (error) { config.oauthGrants = previous; throw error; }
    return {
      access_token: accessToken, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((accessExpiresAt - this.now()) / 1000)),
      scope: grant.scopes.join(' '),
      ...(refreshToken ? { refresh_token: refreshToken, refresh_token_expires_in: Math.max(0, Math.floor((Date.parse(grant.expiresAt) - this.now()) / 1000)) } : {})
    };
  }

  exchangeCode(body, issuer) {
    this.cleanup();
    const auto = body.client_id === AUTO_CLIENT_ID;
    const client = auto ? null : this.client(body.client_id);
    const codeHash = hashToken(body.code);
    const pending = this.codes.get(codeHash);
    if (!pending
      || (!auto && (pending.clientId !== client.id || pending.clientRevision !== client.revision))
      || pending.redirectUri !== body.redirect_uri || pending.issuer !== issuer || !this.isSubjectActive(pending.subject)) {
      throw oauthError('invalid_grant', '授权码无效、已使用或已过期');
    }
    if (typeof body.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) {
      throw oauthError('invalid_grant', 'PKCE code_verifier 无效');
    }
    const challenge = crypto.createHash('sha256').update(body.code_verifier).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(pending.challenge))) throw oauthError('invalid_grant', 'PKCE 校验失败');
    if (auto) {
      // 自动登记的授权码：客户端在确认时才创建，兑换时再校验其实际归属与来源 Key。
      const created = this.getConfig().oauthClients.find((item) => item.id === pending.clientId && item.enabled !== false);
      if (!created || created.revision !== pending.clientRevision
        || !this.getConfig().localApiKeys.some((item) => item.id === pending.sourceKeyId && item.enabled !== false)) {
        throw oauthError('invalid_grant', '授权码无效、已使用或已过期');
      }
    } else {
      this.sourceKey(client);
    }
    const now = this.now();
    const grant = {
      id: random('oauth_grant_'), clientId: pending.clientId, clientRevision: pending.clientRevision, sourceKeyId: pending.sourceKeyId,
      subject: pending.subject, keyAccess: pending.keyAccess, scopes: pending.scopes, status: 'active',
      createdAt: iso(now), expiresAt: iso(now + (pending.scopes.includes('offline_access') ? REFRESH_TTL_MS : ACCESS_TTL_MS)),
      usedRefreshHashes: [], cancelledAt: null, cancelReason: ''
    };
    // 换码过程没有 await；持久化成功后再删除，确保并发请求只能成功一次。
    const result = this.issueTokens(grant);
    this.codes.delete(codeHash);
    return auto ? { ...result, client_id: pending.clientId } : result;
  }

  refresh(body) {
    const client = this.client(body.client_id);
    if (typeof body.refresh_token !== 'string' || !body.refresh_token.startsWith(REFRESH_TOKEN_PREFIX) || body.refresh_token.length > 128) {
      throw oauthError('invalid_grant', '刷新令牌无效');
    }
    const hash = hashToken(body.refresh_token);
    const grants = this.getConfig().oauthGrants;
    const replayed = grants.find((item) => item.clientId === client.id && item.usedRefreshHashes.includes(hash));
    if (replayed) {
      this.revokeWhere((item) => item.id === replayed.id, '检测到旧刷新令牌重放');
      throw oauthError('invalid_grant', '检测到刷新令牌重放，该授权已撤销，请重新登录授权');
    }
    const grant = grants.find((item) => item.clientId === client.id && item.refreshTokenHash === hash);
    if (!this.validGrant(grant) || !grant.scopes.includes('offline_access')) throw oauthError('invalid_grant', '刷新令牌已过期或授权已失效');
    const scopes = body.scope === undefined ? grant.scopes : scopesFrom(body.scope);
    if (scopes.some((scope) => !grant.scopes.includes(scope))) {
      throw oauthError('invalid_scope', '刷新不能扩大原授权范围');
    }
    if (grant.usedRefreshHashes.length >= MAX_REFRESH_HISTORY) {
      this.revokeWhere((item) => item.id === grant.id, '刷新次数达到上限，请重新授权');
      throw oauthError('invalid_grant', '刷新次数达到上限，请重新登录授权');
    }
    // 每次刷新同时轮换两种令牌，旧访问令牌立即失效；授权绝对期限不延长。
    return this.issueTokens({ ...grant, scopes }, hash);
  }

  revokeToken(body) {
    if (typeof body.client_id !== 'string' || typeof body.token !== 'string' || !body.token) throw oauthError('invalid_request', '需要 client_id 和 token');
    const hash = hashToken(body.token);
    this.revokeWhere((grant) => grant.clientId === body.client_id
      && (grant.accessTokenHash === hash || grant.refreshTokenHash === hash || grant.usedRefreshHashes.includes(hash)), '接入应用主动撤销');
    // RFC 7009：未知或已撤销的令牌也返回成功，避免泄露有效性。
    return {};
  }

  saveClient(body, id = '') {
    const config = this.getConfig();
    const existing = id ? this.client(id, false) : null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw oauthError('invalid_request', '应用配置必须是对象');
    const client = normalizeOAuthClient({
      ...(existing || {}), name: body.name ?? existing?.name,
      redirectUris: body.redirectUris ?? existing?.redirectUris, sourceKeyId: body.sourceKeyId ?? existing?.sourceKeyId,
      enabled: body.enabled ?? existing?.enabled, id: existing?.id,
      revision: random(), createdAt: existing?.createdAt, updatedAt: iso(this.now())
    });
    if (client.enabled) this.sourceKey(client);
    const previousClients = config.oauthClients;
    const previousGrants = config.oauthGrants;
    config.oauthClients = [...previousClients.filter((item) => item.id !== client.id), client];
    config.oauthGrants = previousGrants.map((item) => ({ ...item }));
    // 修改来源 Key、回调或停用应用都必须重新征求同意，避免扩大已签发权限。
    this.cancelWhere((grant) => grant.clientId === client.id, '应用配置已变更，请重新授权');
    try { this.save(); } catch (error) { config.oauthClients = previousClients; config.oauthGrants = previousGrants; throw error; }
    return oauthClientPublic(client);
  }

  deleteClient(id) {
    this.client(id, false);
    const config = this.getConfig();
    const previousClients = config.oauthClients;
    const previousGrants = config.oauthGrants;
    config.oauthClients = previousClients.filter((client) => client.id !== id);
    config.oauthGrants = previousGrants.map((item) => ({ ...item }));
    this.cancelWhere((grant) => grant.clientId === id, '应用已删除');
    try { this.save(); } catch (error) { config.oauthClients = previousClients; config.oauthGrants = previousGrants; throw error; }
  }

  publicGrant(grant) {
    const client = this.getConfig().oauthClients.find((item) => item.id === grant.clientId);
    const key = this.getConfig().localApiKeys.find((item) => item.id === grant.sourceKeyId);
    return {
      id: grant.id, type: 'oauth', label: client?.name || '已删除应用', clientId: grant.clientId,
      sourceKeyId: grant.sourceKeyId, sourceKey: key ? { id: key.id, name: key.name, enabled: key.enabled !== false } : null,
      account: grant.subject.username, scopes: [...grant.scopes], status: grant.status,
      active: this.validGrant(grant), createdAt: grant.createdAt, expiresAt: grant.expiresAt,
      cancelledAt: grant.cancelledAt, lastFailureReason: grant.cancelReason || null
    };
  }

  cancelWhere(predicate, reason) {
    let changed = false;
    for (const grant of this.getConfig().oauthGrants) {
      if (grant.status === 'active' && predicate(grant)) {
        grant.status = 'cancelled';
        grant.cancelledAt = iso(this.now());
        grant.cancelReason = reason;
        changed = true;
      }
    }
    return changed;
  }

  clearPending() {
    this.consents.clear();
    this.codes.clear();
  }

  revokeWhere(predicate, reason) {
    const config = this.getConfig();
    const previous = config.oauthGrants;
    config.oauthGrants = previous.map((grant) => ({ ...grant }));
    const changed = this.cancelWhere(predicate, reason);
    if (changed) {
      try { this.save(); } catch (error) { config.oauthGrants = previous; throw error; }
    } else config.oauthGrants = previous;
    return changed;
  }
}

module.exports = { OAuthProvider, ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, AUTO_CLIENT_ID, SCOPES, ACCESS_TTL_MS, REFRESH_TTL_MS, normalizeOAuthState, normalizeOAuthClient, oauthClientPublic, oauthError };