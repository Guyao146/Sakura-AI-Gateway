const fs = require('node:fs');
const path = 'wiki/api.md';

let text = fs.readFileSync(path, 'utf8');
const anchor = '## 认证与健康接口';

if (!text.includes(anchor)) { console.error('anchor missing'); process.exit(1); }
if (text.includes('/api/integration/verify')) { console.log('already present'); process.exit(0); }

const block = [
  '### 第三方接入授权',
  '',
  '供外部软件（如桌面客户端、IDE 插件）把本网关添加为其上游，无需进入后台手动复制 Key：',
  '',
  '| 方法 | 路径 | 说明 |',
  '| --- | --- | --- |',
  '| POST | `/api/integration/verify` | 校验本地 API Key 并登记接入；成功返回一次性明文令牌 |',
  '| POST | `/api/integration/revoke` | 凭令牌自助注销接入 |',
  '| GET | `/api/integration/status` | 管理员查看接入列表（只含哈希，无明文） |',
  '',
  '- `verify` 的 body 为 `{ apiKey, label? }`；`apiKey` 必须是网关本地已启用且有权访问至少一个模型的 Key。',
  '  成功返回 `{ authorization: { id, token, label, createdAt, expiresAt? } }`，**明文令牌只出现这一次**，落盘只存 SHA-256。',
  '- `revoke` 由接入方凭令牌自助调用，无需管理员；删除来源本地 Key 会级联取消其全部接入。',
  '- 三个接口按来源 IP 限流（每分钟 60 次），超限返回 429。',
  '- 登记随配置持久化（`config.integrations`），备份导出包含哈希记录；`status` 与导出均无明文。',
  '',
  '---',
  '',
  '',
].join('\n');

text = text.replace(anchor, block + anchor);
fs.writeFileSync(path, text);
console.log('inserted api.md, lines:', text.split('\n').length);

const dev = 'wiki/development.md';
let devText = fs.readFileSync(dev, 'utf8');
const devAnchor = '| `test/metrics-range.integration.test.js` | 集成 | `/api/admin/metrics/range` 参数校验、闭区间命中、范围与全量统计互不影响 |\n';
if (!devText.includes(devAnchor)) { console.error('dev anchor missing'); process.exit(1); }
if (!devText.includes('integration-auth.test.js')) {
  devText = devText.replace(devAnchor, devAnchor + '| `test/integration-auth.test.js` | 集成 | 接入授权 verify/revoke/status、令牌哈希、Key 删除级联取消、备份导入保留 |\n');
  fs.writeFileSync(dev, devText);
  console.log('inserted development.md');
} else {
  console.log('development.md already has integration-auth');
}