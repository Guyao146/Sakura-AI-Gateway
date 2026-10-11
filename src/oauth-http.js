const { SCOPES, oauthClientPublic, oauthError } = require('./oauth');
const { isLoopbackAddress, normalizeAddress } = require('./admin-auth');

function readOAuthBody(req) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['application/json', 'application/x-www-form-urlencoded'].includes(type)) {
      req.resume();
      reject(oauthError('invalid_request', '请使用 application/json 或 application/x-www-form-urlencoded', 415));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        chunks.length = 0;
        reject(oauthError('invalid_request', '授权请求体过大', 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 16 * 1024) { reject(oauthError('invalid_request', '授权请求体过大', 413)); return; }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = type === 'application/json' ? JSON.parse(raw) : uniqueParameters(new URLSearchParams(raw));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid body');
        resolve(body);
      } catch { reject(oauthError('invalid_request', '授权请求体格式无效或存在重复参数')); }
    });
    req.on('aborted', () => reject(oauthError('invalid_request', '授权请求已中断')));
    req.on('error', reject);
  });
}

function uniqueParameters(parameters) {
  const result = Object.create(null);
  for (const [key, value] of parameters) {
    if (Object.hasOwn(result, key)) throw oauthError('invalid_request', `不允许重复参数：${key}`);
    result[key] = value;
  }
  return result;
}

function createOAuthHandler({ provider, adminAuth, getConfig, accountAccess, subjectForAccess, isSameOrigin, requireAdmin, serveStatic }) {
  const windows = new Map();
  function admit(req) {
    const now = Date.now();
    for (const [key, value] of windows) if (value.until <= now) windows.delete(key);
    const source = adminAuth.source(req);
    const key = source.address || source.socketAddress || 'unknown';
    const entry = windows.get(key) || { until: now + 60000, count: 0 };
    if (entry.count >= 120 || (!windows.has(key) && windows.size >= 5000)) throw oauthError('temporarily_unavailable', '授权请求过于频繁，请稍后重试', 429);
    entry.count += 1;
    windows.set(key, entry);
  }

  function issuerFor(req) {
    const host = String(req.headers.host || '');
    if (!host || /[\s\\/@?#]/.test(host)) throw oauthError('invalid_request', '网关 Host 无效');
    const trusted = adminAuth.trustedProxies.has(normalizeAddress(req.socket?.remoteAddress));
    const secure = req.socket?.encrypted || (trusted && req.headers['x-forwarded-proto'] === 'https');
    let url;
    try { url = new URL(`${secure ? 'https' : 'http'}://${host}`); } catch { throw oauthError('invalid_request', '网关 Host 无效'); }
    if (adminAuth.remoteMode() === 'oidc' && adminAuth.isConfigured()) {
      const configured = new URL(adminAuth.redirectUri);
      if (url.origin !== configured.origin) throw oauthError('invalid_request', '请使用配置的 OIDC 网关地址和协议发起账号授权');
    }
    const local = isLoopbackAddress(adminAuth.source(req).address) && (url.hostname === 'localhost' || isLoopbackAddress(url.hostname));
    if (!secure && !local) {
      throw oauthError('invalid_request', '远程账号授权必须通过 HTTPS；反向代理需要配置信任地址和 X-Forwarded-Proto');
    }
    return url.origin;
  }

  function json(res, status, body, publicCors = false) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
      ...(publicCors ? { 'Access-Control-Allow-Origin': '*' } : {})
    });
    res.end(text);
  }

  function account(req) {
    const access = accountAccess(req);
    if (!access.ok) throw oauthError('login_required', '请先登录网关账号', 401);
    if (!isSameOrigin(req, access)) throw oauthError('access_denied', '授权请求来源不受信任', 403);
    return access;
  }

  return async function handleOAuth(req, res, url) {
    const path = url.pathname;
    const adminRoute = path === '/api/admin/oauth-clients' || path.startsWith('/api/admin/oauth-clients/');
    if (!adminRoute && !path.startsWith('/oauth/') && path !== '/.well-known/oauth-authorization-server') return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const publicCors = path === '/oauth/token' || path === '/oauth/revoke' || path === '/.well-known/oauth-authorization-server';
    try {
      if (adminRoute) {
        if (!requireAdmin(req, res)) return true;
        if (path === '/api/admin/oauth-clients' && req.method === 'GET') {
          json(res, 200, { clients: getConfig().oauthClients.map(oauthClientPublic), scopes: SCOPES });
        } else if (path === '/api/admin/oauth-clients' && req.method === 'POST') {
          json(res, 201, { client: provider.saveClient(await readOAuthBody(req)) });
        } else if (/^\/api\/admin\/oauth-clients\/[^/]+$/.test(path) && ['PUT', 'DELETE'].includes(req.method)) {
          const id = decodeURIComponent(path.split('/').at(-1));
          if (req.method === 'PUT') json(res, 200, { client: provider.saveClient(await readOAuthBody(req), id) });
          else { provider.deleteClient(id); json(res, 200, { deleted: true }); }
        } else json(res, 404, { error: 'not_found', error_description: '应用管理接口不存在' });
        return true;
      }
      const issuer = issuerFor(req);
      if (path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
        json(res, 200, {
          issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`, revocation_endpoint: `${issuer}/oauth/revoke`,
          scopes_supported: Object.keys(SCOPES), response_types_supported: ['code'], response_modes_supported: ['query'],
          grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true
        }, true);
        return true;
      }
      admit(req);
      if (['/oauth/authorize', '/oauth/consent'].includes(path) && `/oauth/authorize${url.search}`.length > 4096) {
        throw oauthError('invalid_request', '授权 URL 过长，请缩短回调查询参数或 state', 414);
      }
      if (path === '/oauth/authorize' && req.method === 'GET') {
        provider.validateAuthorization(uniqueParameters(url.searchParams), issuer);
        serveStatic(res, path, 'authorize.html');
      } else if (path === '/oauth/consent' && req.method === 'GET') {
        const parameters = uniqueParameters(url.searchParams);
        provider.validateAuthorization(parameters, issuer);
        const access = accountAccess(req);
        if (!access.ok) {
          const returnTo = `/oauth/authorize?${url.searchParams}`;
          json(res, 401, { error: 'login_required', error_description: '请先登录网关账号', login_url: `/auth/login?account=1&returnTo=${encodeURIComponent(returnTo)}` });
        } else {
          if (!isSameOrigin(req, access)) throw oauthError('access_denied', '授权请求来源不受信任', 403);
          json(res, 200, provider.createConsent(parameters, access.session.id, subjectForAccess(access), issuer));
        }
      } else if (path === '/oauth/consent' && req.method === 'POST') {
        const access = account(req);
        // Cookie 鉴权的写操作必须来自网关页面；不能通过跨站表单跳过确认。
        if (req.headers.origin !== issuer) throw oauthError('access_denied', '授权确认必须来自网关同源页面', 403);
        json(res, 200, provider.decideConsent(await readOAuthBody(req), access.session.id, subjectForAccess(access), issuer));
      } else if (path === '/oauth/token' && req.method === 'POST') {
        const body = await readOAuthBody(req);
        if (req.headers.authorization || body.client_secret !== undefined) throw oauthError('invalid_client', '登记的公开客户端必须使用 PKCE，不接受客户端密码');
        if (Object.values(body).some((value) => typeof value !== 'string')) throw oauthError('invalid_request', 'Token 请求参数必须为字符串');
        const result = body.grant_type === 'authorization_code' ? provider.exchangeCode(body, issuer)
          : body.grant_type === 'refresh_token' ? provider.refresh(body)
            : (() => { throw oauthError('unsupported_grant_type', '只支持 authorization_code 和 refresh_token'); })();
        json(res, 200, result, true);
      } else if (path === '/oauth/revoke' && req.method === 'POST') {
        json(res, 200, provider.revokeToken(await readOAuthBody(req)), true);
      } else if (path === '/oauth/grants' && req.method === 'GET') {
        const access = account(req);
        const subject = subjectForAccess(access);
        json(res, 200, { grants: getConfig().oauthGrants.filter((grant) => grant.subject.id === subject.id && grant.subject.mode === subject.mode && grant.subject.issuer === subject.issuer).map((grant) => provider.publicGrant(grant)) });
      } else if (path === '/oauth/grants/revoke' && req.method === 'POST') {
        const access = account(req);
        if (req.headers.origin !== issuer) throw oauthError('access_denied', '撤销请求必须来自网关同源页面', 403);
        const body = await readOAuthBody(req);
        const subject = subjectForAccess(access);
        const grant = getConfig().oauthGrants.find((item) => item.id === body.id && item.subject.id === subject.id && item.subject.mode === subject.mode && item.subject.issuer === subject.issuer);
        if (!grant) throw oauthError('invalid_request', '授权不存在', 404);
        provider.revokeWhere((item) => item.id === grant.id, '账号所有者撤销');
        json(res, 200, { revoked: true });
      } else json(res, 404, { error: 'not_found', error_description: '账号授权接口不存在' });
    } catch (error) {
      if (!res.headersSent) json(res, error.oauthCode ? error.statusCode : 500, { error: error.oauthCode || 'server_error', error_description: error.oauthCode ? error.message : '账号授权服务暂时不可用' }, publicCors);
    }
    return true;
  };
}

module.exports = { createOAuthHandler };