const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const {
  TOKEN_PREFIX,
  hashToken,
  generateToken,
  normalizeIntegration,
  integrationPublic,
  buildVerifyResponse
} = require('../src/integration');

const projectRoot = path.join(__dirname, '..');

// 单元部分：令牌哈希与对外视图不依赖进程状态。
assert.equal(hashToken('abc'), hashToken('abc'));
assert.notEqual(hashToken('abc'), hashToken('abd'));
const token = generateToken();
assert.ok(token.startsWith(TOKEN_PREFIX));
assert.ok(generateToken() !== token);
const normalized = normalizeIntegration({ tokenHash: hashToken(token), sourceKeyId: 'key_a', label: '接入方' });
assert.equal(normalized.status, 'active');
assert.equal(normalized.cancelledAt, null);
assert.equal(normalizeIntegration({ status: 'cancelled', tokenHash: 'x', cancelledAt: '2026-01-01T00:00:00Z' }).status, 'cancelled');
assert.equal(integrationPublic(normalized).tokenHash, undefined, '对外视图不应暴露哈希');
const verifyPayload = buildVerifyResponse({
  integration: normalized,
  key: { id: 'key_a', name: '默认', modelAccessMode: 'all', allowedGroups: [], allowedModels: [] },
  models: [],
  plainToken: token
});
assert.equal(verifyPayload.verified, true);
assert.equal(verifyPayload.authorization.token, token);
assert.equal(verifyPayload.endpoints.openai.chat, '/v1/chat/completions');
assert.equal(buildVerifyResponse({ integration: normalized, key: { id: 'key_a' }, models: [] }).authorization.token, undefined, '非首次验证不应回传明文令牌');

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
        resolve({ status: response.statusCode, headers: response.headers, body });
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`等待网关启动超时：${output}`)), 10000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        clearTimeout(timer);
        child.stdout.removeListener('data', onData);
        resolve(output);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', reject);
  });
}

async function main() {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sakura-ai-gateway-integration-'));
  const gatewayPort = 21500 + Math.floor(Math.random() * 1000);
  const gateway = spawn(process.execPath, ['src/server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(gatewayPort), LOCAL_MODEL_GATEWAY_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  gateway.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    const output = await waitForOutput(gateway, '本地管理访问：无需认证');
    const base = `http://127.0.0.1:${gatewayPort}`;
    const adminHeaders = {};
    const stored = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    const apiKey = stored.localApiKeys[0].key;
    const keyId = stored.localApiKeys[0].id;
    const initialConfig = await requestJson(`${base}/api/admin/config`, { headers: adminHeaders });
    assert.deepEqual(initialConfig.body.integrations, [], '初始配置不应有接入授权');

    const upstream = await requestJson(`${base}/api/admin/upstreams`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Integration Source', baseUrl: 'http://127.0.0.1:9/v1', protocol: 'openai', authType: 'none', apiKey: '', models: 'demo-model,o3-mini' })
    });
    assert.equal(upstream.status, 201, JSON.stringify(upstream.body));

    const verifyEndpoint = `${base}/api/integration/verify`;
    const missingKey = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({}) });
    assert.equal(missingKey.status, 401);
    assert.equal(missingKey.body.error?.code, 'unauthorized');

    const badToken = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, authorization: 'sakura-int_nonexistent' }) });
    assert.equal(badToken.status, 401);
    assert.equal(badToken.body.error?.code, 'invalid_authorization');

    const first = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, label: '外部软件' }) });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.verified, true);
    assert.equal(first.body.gateway.service, 'sakura-ai-gateway');
    assert.equal(typeof first.body.gateway.version, 'string');
    const authorizationToken = first.body.authorization.token;
    assert.ok(typeof authorizationToken === 'string' && authorizationToken.startsWith(TOKEN_PREFIX), '首次验证应返回明文令牌');
    assert.deepEqual(Object.keys(first.body.authorization).filter((key) => key === 'token'), ['token']);
    assert.equal(first.body.apiKey.id, keyId);
    assert.equal(first.body.apiKey.modelAccessMode, 'all');
    assert.equal(first.body.endpoints.openai.models, '/v1/models');
    assert.equal(first.body.endpoints.anthropic.messages, '/v1/messages');
    const modelIds = first.body.models.map((model) => model.id).sort();
    assert.deepEqual(modelIds, ['demo-model', 'o3-mini']);
    const o3 = first.body.models.find((model) => model.id === 'o3-mini');
    assert.equal(o3.supportsThinking, true, '应回传推断出的思考能力');
    assert.deepEqual(o3.thinkingLevels, ['low', 'medium', 'high']);

    const second = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, authorization: authorizationToken }) });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.authorization.token, undefined, '令牌明文只应返回一次');
    assert.equal(second.body.authorization.successCount, 2);

    const status = await requestJson(`${base}/api/integration/status`, { headers: { Authorization: `Bearer ${authorizationToken}` } });
    assert.equal(status.status, 200);
    assert.equal(status.body.authorization.status, 'active');
    assert.equal(status.body.authorization.label, '外部软件');
    assert.equal(status.body.apiKey.id, keyId);
    const statusNoToken = await requestJson(`${base}/api/integration/status`);
    assert.equal(statusNoToken.status, 401);
    assert.equal(statusNoToken.body.error?.code, 'invalid_authorization');

    const revokeEndpoint = `${base}/api/integration/revoke`;
    const revokeUnknown = await requestJson(revokeEndpoint, { method: 'POST', body: JSON.stringify({ authorization: 'sakura-int_missing' }) });
    assert.equal(revokeUnknown.status, 404);
    assert.equal(revokeUnknown.body.error?.code, 'authorization_not_found');

    const revoked = await requestJson(revokeEndpoint, { method: 'POST', body: JSON.stringify({ authorization: authorizationToken }) });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    assert.equal(revoked.body.revoked, true);
    assert.equal(revoked.body.authorization.status, 'cancelled');
    assert.ok(revoked.body.authorization.cancelledAt);
    const revokedAgain = await requestJson(revokeEndpoint, { method: 'POST', body: JSON.stringify({ authorization: authorizationToken }) });
    assert.equal(revokedAgain.status, 200);
    assert.equal(revokedAgain.body.alreadyCancelled, true, '重复取消应幂等成功');

    const afterRevoke = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, authorization: authorizationToken }) });
    assert.equal(afterRevoke.status, 403);
    assert.equal(afterRevoke.body.error?.code, 'authorization_cancelled');

    // 取消后仍可建立新授权：新令牌与旧令牌互不影响。
    const fresh = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey }) });
    assert.equal(fresh.status, 200);
    assert.notEqual(fresh.body.authorization.token, authorizationToken);

    // 停用底层 Key 后验证失败，授权记录留下失败原因。
    const disabledKey = await requestJson(`${base}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: stored.localApiKeys[0].name, enabled: false })
    });
    assert.equal(disabledKey.status, 200, JSON.stringify(disabledKey.body));
    const disabledVerify = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, authorization: fresh.body.authorization.token }) });
    assert.equal(disabledVerify.status, 401);
    assert.equal(disabledVerify.body.error?.code, 'unauthorized');

    // 删除 Key 会取消其全部授权；重新启用一个新 Key 后可继续接入。
    const reenabled = await requestJson(`${base}/api/admin/local-keys/${encodeURIComponent(keyId)}`, {
      method: 'PUT', headers: adminHeaders, body: JSON.stringify({ name: stored.localApiKeys[0].name, enabled: true })
    });
    assert.equal(reenabled.status, 200, JSON.stringify(reenabled.body));
    const another = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, label: '第二个接入' }) });
    assert.equal(another.status, 200);
    const anotherToken = another.body.authorization.token;
    const deleted = await requestJson(`${base}/api/admin/local-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(deleted.status, 400, '最后一个 Key 不允许删除');
    await requestJson(`${base}/api/admin/local-keys`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Replacement', modelAccessMode: 'all' })
    });
    const replaced = await requestJson(`${base}/api/admin/local-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE', headers: adminHeaders });
    assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
    const cascade = replaced.body.integrations.find((item) => item.id === another.body.authorization.id);
    assert.equal(cascade.status, 'cancelled', '删除 Key 应级联取消其接入授权');
    const cascadeVerify = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey, authorization: anotherToken }) });
    assert.equal(cascadeVerify.status, 403);
    assert.equal(cascadeVerify.body.error?.code, 'authorization_cancelled');

    // 持久化与脱敏：配置文件只存哈希；管理配置视图不含哈希。
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'config.json'), 'utf8'));
    assert.ok(Array.isArray(persisted.integrations) && persisted.integrations.length >= 2);
    assert.ok(persisted.integrations.every((item) => !('plainToken' in item) && item.tokenHash && !item.tokenHash.startsWith(TOKEN_PREFIX)));
    assert.ok(!JSON.stringify(persisted).includes(authorizationToken), '明文令牌不得落盘');
    const adminView = await requestJson(`${base}/api/admin/config`, { headers: adminHeaders });
    assert.ok(adminView.body.integrations.every((item) => !('tokenHash' in item)), '管理视图不应暴露令牌哈希');
    assert.ok(adminView.body.integrations.some((item) => item.status === 'cancelled' && item.lastFailureReason));
    const exported = await requestJson(`${base}/api/admin/config/export`, { headers: adminHeaders });
    assert.ok(exported.body.config.integrations.some((item) => item.tokenHash), '备份应携带令牌哈希以保留取消状态');

    // 用替换 Key 再建一个 active 授权后导出：导入后取消状态与可用授权都保留。
    const replacementKeyResponse = await requestJson(`${base}/api/admin/local-keys`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ name: 'Post Delete' })
    });
    assert.equal(replacementKeyResponse.status, 201, JSON.stringify(replacementKeyResponse.body));
    const postDelete = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey: replacementKeyResponse.body.item.key, label: '导入后仍可用' }) });
    assert.equal(postDelete.status, 200);
    const exportedLatest = await requestJson(`${base}/api/admin/config/export`, { headers: adminHeaders });
    assert.ok(exportedLatest.body.config.integrations.some((item) => item.tokenHash), '备份应携带令牌哈希以保留取消状态');
    const imported = await requestJson(`${base}/api/admin/config/import`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ ...exportedLatest.body, preserveCredentials: false })
    });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.ok(imported.body.integrations.some((item) => item.status === 'cancelled'));
    assert.ok(imported.body.integrations.some((item) => item.status === 'active'));
    // 导入保留的授权仍能用于验证与取消。
    const afterImport = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey: replacementKeyResponse.body.item.key, authorization: postDelete.body.authorization.token }) });
    assert.equal(afterImport.status, 200, JSON.stringify(afterImport.body));
    const revokeAfterImport = await requestJson(revokeEndpoint, { method: 'POST', body: JSON.stringify({ authorization: postDelete.body.authorization.token }) });
    assert.equal(revokeAfterImport.status, 200);
    assert.equal(revokeAfterImport.body.authorization.status, 'cancelled');

    // 频率限制：同来源每分钟 60 次，超限返回 429。
    const replacementKey = imported.body.localApiKeys.find((item) => item.enabled !== false);
    let limited = 0;
    for (let index = 0; index < 80; index += 1) {
      const result = await requestJson(verifyEndpoint, { method: 'POST', body: JSON.stringify({ apiKey: replacementKey.key }) });
      if (result.status === 429) {
        limited += 1;
        assert.equal(result.body.error?.code, 'rate_limited');
      }
    }
    assert.ok(limited > 0, '同来源高频验证应触发限流');

    console.log('integration authorization tests passed');
  } catch (error) {
    throw new Error(`${error.message}\n${stderr}`);
  } finally {
    gateway.kill();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});