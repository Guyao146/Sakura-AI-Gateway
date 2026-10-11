const crypto = require('node:crypto');

const TOKEN_PREFIX = 'sakura-int_';
const GATEWAY_VERSION = require('../package.json').version;
const SERVICE_NAME = 'sakura-ai-gateway';

// 接入方把这些相对路径拼到它填写的网关地址之后使用，例如 https://gateway.example.com/v1/chat/completions。
const ENDPOINTS = Object.freeze({
  openai: { models: '/v1/models', chat: '/v1/chat/completions', responses: '/v1/responses' },
  anthropic: { messages: '/v1/messages' }
});

function nowIso() {
  return new Date().toISOString();
}

function makeIntegrationId() {
  return `int_${crypto.randomBytes(6).toString('hex')}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

// 与本地 API Key 相同强度的随机串；明文只在创建时返回一次，服务端只保留哈希。
function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(24).toString('base64url');
}

// 归一化存储记录：兼容老备份缺字段的情况，tokenHash 留空时按无效令牌处理。
function normalizeIntegration(item = {}) {
  const status = item?.status === 'cancelled' ? 'cancelled' : 'active';
  return {
    id: String(item?.id || makeIntegrationId()),
    tokenHash: String(item?.tokenHash || ''),
    label: String(item?.label || '').slice(0, 100),
    sourceKeyId: String(item?.sourceKeyId || ''),
    status,
    createdAt: item?.createdAt || nowIso(),
    cancelledAt: status === 'cancelled' ? (item?.cancelledAt || nowIso()) : null,
    lastVerifiedAt: item?.lastVerifiedAt || null,
    lastFailureAt: item?.lastFailureAt || null,
    lastFailureReason: item?.lastFailureReason ? String(item.lastFailureReason).slice(0, 200) : null,
    successCount: Number.isInteger(item?.successCount) ? Math.max(0, item.successCount) : 0,
    failureCount: Number.isInteger(item?.failureCount) ? Math.max(0, item.failureCount) : 0
  };
}

// 对外视图：不含 tokenHash，避免哈希泄露后被离线比对。
function integrationPublic(item) {
  if (!item) return null;
  return {
    id: item.id,
    label: item.label,
    sourceKeyId: item.sourceKeyId,
    status: item.status,
    createdAt: item.createdAt,
    cancelledAt: item.cancelledAt,
    lastVerifiedAt: item.lastVerifiedAt,
    lastFailureAt: item.lastFailureAt,
    lastFailureReason: item.lastFailureReason,
    successCount: item.successCount,
    failureCount: item.failureCount
  };
}

function integrationErrorBody(code, message, extra = {}) {
  return { error: { code, message, type: 'integration_error' }, ...extra };
}

// verify 成功时返回的标准化配置：接入方据此把网关配成上游。
function buildVerifyResponse({ integration, key, models, plainToken = null }) {
  return {
    verified: true,
    gateway: { service: SERVICE_NAME, version: GATEWAY_VERSION },
    authorization: plainToken
      ? { ...integrationPublic(integration), token: plainToken, tokenNotice: '令牌明文仅返回一次，请立即保存' }
      : integrationPublic(integration),
    apiKey: {
      id: key.id,
      name: key.name,
      modelAccessMode: key.modelAccessMode,
      allowedGroups: key.allowedGroups || [],
      allowedModels: key.allowedModels || []
    },
    endpoints: ENDPOINTS,
    endpointHint: 'endpoints 为相对路径，请拼接在你填写的网关地址之后',
    models,
    verifiedAt: nowIso()
  };
}

module.exports = {
  TOKEN_PREFIX,
  ENDPOINTS,
  hashToken,
  generateToken,
  normalizeIntegration,
  integrationPublic,
  integrationErrorBody,
  buildVerifyResponse
};