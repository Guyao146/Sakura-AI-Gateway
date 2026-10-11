const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeIntegration, integrationPublic } = require('./integration');
const { normalizeOAuthState, oauthClientPublic } = require('./oauth');

// 旧名称仅用于升级兼容；显式配置的新变量（包括 false/空值）优先。
const DATA_DIR = (process.env.SAKURA_AI_GATEWAY_DATA_DIR ?? process.env.LOCAL_MODEL_GATEWAY_DATA_DIR) || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const FORCED_HOST = String((process.env.SAKURA_AI_GATEWAY_FORCE_HOST ?? process.env.LOCAL_MODEL_GATEWAY_FORCE_HOST) || '').trim();
const FORCED_PORT = Number((process.env.SAKURA_AI_GATEWAY_FORCE_PORT ?? process.env.LOCAL_MODEL_GATEWAY_FORCE_PORT) || 0);
const FORCE_SETTINGS = (process.env.SAKURA_AI_GATEWAY_FORCE_SETTINGS ?? process.env.LOCAL_MODEL_GATEWAY_FORCE_SETTINGS) === 'true';

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function makeSecret(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

const ADMIN_REMOTE_MODES = ['oidc', 'password'];

function normalizeAdminAuth(value = {}, env = process.env) {
  const fromEnv = String(env.ADMIN_REMOTE_MODE || '').trim().toLowerCase();
  const mode = ADMIN_REMOTE_MODES.includes(fromEnv)
    ? fromEnv
    : (ADMIN_REMOTE_MODES.includes(value?.remoteMode) ? value.remoteMode : 'oidc');
  const users = Array.isArray(value?.users) ? value.users.filter((item) => item && typeof item === 'object') : [];
  return {
    remoteMode: mode,
    requireLocalLogin: value?.requireLocalLogin === true,
    users: users.map((item) => ({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : makeId('admin'),
      username: String(item.username || '').trim(),
      passwordHash: typeof item.passwordHash === 'string' ? item.passwordHash : '',
      enabled: item.enabled !== false,
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: item.updatedAt || new Date().toISOString()
    })).filter((item) => item.username && item.passwordHash)
  };
}

function defaultConfig() {
  return {
    version: 1,
    adminToken: makeSecret('admin'),
    adminAuth: normalizeAdminAuth(undefined),
    localApiKeys: [
      {
        id: makeId('key'),
        name: '默认本地 Key',
        key: makeSecret('sk-local'),
        enabled: true,
        modelAccessMode: 'all',
        allowedGroups: [],
        allowedModels: [],
        createdAt: new Date().toISOString()
      }
    ],
    upstreams: [],
    routes: [],
    modelSelections: [],
    modelSelectionMode: false,
    // 第三方软件的接入授权：令牌只存哈希，取消后续授权后立即失效。
    integrations: [],
    oauthClients: [],
    oauthGrants: [],
    settings: {
      host: FORCED_HOST || process.env.HOST || '127.0.0.1',
      port: FORCED_PORT || Number(process.env.PORT || 8787),
      upstreamTimeoutMs: 600000,
      maxFallbackAttempts: 0,
      upstreamRetries: 0,
      retryDelayMs: 0,
      circuitBreakerFailureThreshold: 3,
      circuitBreakerCooldownMs: 60000,
      maxConcurrentRequests: 0,
      requestsPerMinute: 0,
      errorPrefix: ''
    }
  };
}

function normalizeSettings(settings = {}) {
  const integer = (value, fallback, min, max) => {
    const number = Number(value);
    return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
  };
  const defaults = defaultConfig().settings;
  return {
    host: typeof settings.host === 'string' && settings.host.trim() ? settings.host.trim() : defaults.host,
    port: integer(settings.port, defaults.port, 1, 65535),
    upstreamTimeoutMs: integer(settings.upstreamTimeoutMs, defaults.upstreamTimeoutMs, 1000, 3600000),
    maxFallbackAttempts: integer(settings.maxFallbackAttempts, defaults.maxFallbackAttempts, 0, 12),
    upstreamRetries: integer(settings.upstreamRetries, defaults.upstreamRetries, 0, 10),
    retryDelayMs: integer(settings.retryDelayMs, defaults.retryDelayMs, 0, 30000),
    circuitBreakerFailureThreshold: integer(settings.circuitBreakerFailureThreshold, defaults.circuitBreakerFailureThreshold, 1, 20),
    circuitBreakerCooldownMs: integer(settings.circuitBreakerCooldownMs, defaults.circuitBreakerCooldownMs, 1000, 3600000),
    maxConcurrentRequests: integer(settings.maxConcurrentRequests, defaults.maxConcurrentRequests, 0, 1000),
    requestsPerMinute: integer(settings.requestsPerMinute, defaults.requestsPerMinute, 0, 10000),
    errorPrefix: typeof settings.errorPrefix === 'string' ? settings.errorPrefix.trim().slice(0, 60) : ''
  };
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const config = defaultConfig();
    saveConfig(config);
    return config;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = {
      ...defaultConfig(),
      ...parsed,
      adminAuth: normalizeAdminAuth(parsed.adminAuth),
      localApiKeys: Array.isArray(parsed.localApiKeys) ? parsed.localApiKeys : [],
      upstreams: Array.isArray(parsed.upstreams) ? parsed.upstreams : [],
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
      modelSelections: Array.isArray(parsed.modelSelections) ? parsed.modelSelections : [],
      modelSelectionMode: parsed.modelSelectionMode === true,
      integrations: Array.isArray(parsed.integrations) ? parsed.integrations.map(normalizeIntegration) : [],
      ...normalizeOAuthState(parsed)
    };
    merged.settings = normalizeSettings(parsed.settings || merged.settings);
    if (FORCE_SETTINGS || FORCED_HOST) merged.settings.host = FORCED_HOST || process.env.HOST || merged.settings.host;
    if ((FORCE_SETTINGS || FORCED_PORT) && Number(process.env.PORT) >= 1 && Number(process.env.PORT) <= 65535) merged.settings.port = Number(process.env.PORT);
    if (FORCED_PORT >= 1 && FORCED_PORT <= 65535) merged.settings.port = FORCED_PORT;
    return merged;
  } catch (error) {
    throw new Error(`配置文件损坏，无法读取 ${CONFIG_PATH}: ${error.message}`);
  }
}

function saveConfig(config) {
  ensureDataDir();
  const tempPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Windows does not expose Unix file modes consistently.
  }
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function publicConfig(config) {
  return {
    version: config.version,
    adminAuth: adminAuthSummary(config.adminAuth),
    localApiKeys: config.localApiKeys.map((item) => ({ ...item })),
    upstreams: config.upstreams.map((item) => ({
      ...item,
      apiKey: maskSecret(item.apiKey)
    })),
    routes: config.routes,
    modelSelections: config.modelSelections || [],
    modelSelectionMode: config.modelSelectionMode === true,
    settings: config.settings,
    integrations: (config.integrations || []).map(integrationPublic),
    oauthClients: (config.oauthClients || []).map(oauthClientPublic)
  };
}

function adminAuthSummary(value = {}) {
  const mode = value?.remoteMode === 'password' ? 'password' : 'oidc';
  return {
    remoteMode: mode,
    requireLocalLogin: value?.requireLocalLogin === true,
    users: Array.isArray(value?.users) ? value.users.map((item) => ({
      id: String(item.id || ''),
      username: String(item.username || ''),
      enabled: item.enabled !== false,
      createdAt: item.createdAt || null,
      updatedAt: item.updatedAt || null
    })) : []
  };
}

function maskPasswordHash(hash = '') {
  if (!hash) return '';
  return `${hash.slice(0, 10)}••••`;
}

module.exports = {
  CONFIG_PATH,
  ADMIN_REMOTE_MODES,
  loadConfig,
  saveConfig,
  publicConfig,
  normalizeAdminAuth,
  adminAuthSummary,
  maskPasswordHash,
  makeId,
  makeSecret,
  maskSecret,
  normalizeSettings
};
