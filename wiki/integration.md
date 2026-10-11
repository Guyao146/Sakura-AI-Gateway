# 第三方接入指南

网关保留 API Key 接入，同时支持复用网关账号登录的 **OAuth 2.0 授权码 + S256 PKCE**。这是模型调用授权，不是向第三方提供网关管理员身份：第三方不会获得账号密码、原始 API Key、OIDC ID Token 或管理权限。

## 选择接入方式

| 方式 | 接入方需要 | 模型鉴权 | 取消后的效果 |
| --- | --- | --- | --- |
| 账号授权（推荐） | 网关地址、管理员登记的 Client ID、回调地址、PKCE | `sakura-at_` 访问令牌 | 该授权的模型访问与刷新全部失效 |
| API Key 接入 | 网关地址、用户提供的本地 Key | 原始 `sk-local_` Key | 取消接入登记只停止登记令牌刷新配置，原始 Key 仍可调用模型 |

当前网关只有管理员账号，没有独立普通用户体系。用户通过网关现有的本地账号或 OIDC 登录；**本机免登录管理不等同于已登录账号，仍须登录并确认授权**。浏览器会话、第三方授权和 API Key 互相独立。

## 管理员准备

1. 在「访问控制 → 管理认证」配置本地账号密码或 OIDC 登录方式。
2. 在「访问控制 → 本地调用 Key」创建或选择一个来源 Key，设置允许的分组和模型。建议为不同应用使用独立、最小权限的自定义 Key。
3. 在同页「账号授权应用 → 登记应用」填写名称、来源 Key 和 1–10 个准确的回调 URL。
4. 将生成的 **Client ID** 交给接入方；不需要、也不应提供来源 Key 明文。

客户端是 **public client**：不分发 Client Secret，不支持密码模式、隐式模式或 `client_credentials`。应用名称最多 100 字符，回调地址最多 2048 字符，必须逐字符匹配登记值，包括端口、路径和查询参数。禁止通配符、URL 用户名／密码、片段，以及预设的 `code`、`state`、`error`、`error_description`、`iss` 查询参数。

远程网关和应用回调必须使用 HTTPS。本机开发回调可使用 HTTP `localhost`、`127.0.0.1` 或 `[::1]`，但端口仍须预先登记，不支持任意动态端口。网关位于反向代理之后时，配置 `TRUSTED_PROXY_ADDRESSES`，保留公开 `Host` 并设置 `X-Forwarded-For`、`X-Forwarded-Proto: https`；仅信任列出的代理 IP。OIDC 模式还要求使用 `AUTHENTIK_REDIRECT_URI` 的同一公开 origin。

**应用回调不得与网关使用相同主机名，即使端口不同也会拒绝授权**：Cookie 不按端口隔离，否则浏览器会将网关管理 Cookie 发给接入应用。生产环境使用独立域名；本机例如网关使用 `127.0.0.1`，应用回调使用 `localhost`（应用须监听相应回环地址）。

## 1. 发现授权服务

```http
GET /.well-known/oauth-authorization-server
```

返回 `issuer`、`authorization_endpoint`、`token_endpoint`、`revocation_endpoint`、`scopes_supported`、`code_challenge_methods_supported: ["S256"]` 和 `token_endpoint_auth_methods_supported: ["none"]`。使用用户配置的网关地址拼接，不要使用未验证的外部页面提供的端点。

## 2. 生成 PKCE 并跳转

接入方为每次授权生成并保存独立的随机 `state` 与 `code_verifier`。Node.js 内置模块示例：

```js
const crypto = require('node:crypto');

function createAuthorizationRequest(gatewayUrl, clientId, redirectUri) {
  const state = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const url = new URL('/oauth/authorize', gatewayUrl);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: 'models:read models:invoke offline_access', state,
    code_challenge: challenge, code_challenge_method: 'S256'
  }).toString();
  return { url: url.href, state, codeVerifier };
}
```

将 `state` 与 `codeVerifier` 绑定到当前接入用户会话并短期保存，然后让浏览器打开返回的 URL。**不要把 `code_verifier` 放在授权 URL、日志或回调参数中**。Verifier 必须为 43–128 个字符，仅可含 `A–Z a–z 0–9 - . _ ~`。

| scope | 权限 |
| --- | --- |
| `models:read` | `GET /v1/models` 与 `GET /api/integration/config` |
| `models:invoke` | Chat Completions、Messages、Responses 模型调用，包含流式请求 |
| `offline_access` | 签发刷新令牌，允许浏览器会话退出后继续连接，绝对期限 30 天 |

省略 `scope` 默认 `models:read models:invoke`，不签发刷新令牌。必须至少请求一种模型权限。`state` 必填，最长 512 字符；授权 URL 路径与查询合计最多 4096 字符。state 由接入方生成和校验，网关只能原样返回，无法判断接入方是否正确保护会话。

网关展示应用、当前账号、准确回调、来源 Key、模型列表及请求范围；用户必须点击「允许授权」或「拒绝」。待确认请求 10 分钟有效，确认操作绑定登录会话、CSRF 随机值和同源 Origin。

## 3. 校验回调并换码

同意后，网关向登记回调添加 `code`、原始 `state` 和 `iss`（网关 origin）；拒绝时添加 `error=access_denied`、`error_description`、`state`、`iss`，不签发令牌。

接入方必须先校验：

- `state` 与该用户发起请求时保存的值相等，且此次交易尚未处理；
- `iss` 与最初选择的网关 `issuer` 相等，防止混用不同授权服务；
- 回调包含 `error` 时停止换码并展示失败原因。

校验通过后发送：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&client_id=登记的ClientID&code=回调授权码&redirect_uri=原始回调URL&code_verifier=原始Verifier
```

表单值必须使用 URL 编码，例如 `new URLSearchParams(fields)`；也接受字段值均为字符串的 JSON。不要携带 `Authorization: Basic` 或 `client_secret`。授权码仅 2 分钟有效，一次性兑换；网关重启后尚未兑换的授权码失效。错误 verifier、错误应用、错误回调、过期或重放均失败。

成功响应字段：`access_token`、`token_type: "Bearer"`、`expires_in`（通常 3600）、空格分隔的 `scope`。请求 `offline_access` 时额外返回 `refresh_token` 和 `refresh_token_expires_in`（首次通常 2592000）。这些是随机、不透明令牌，不是 JWT，客户端不能自行解析其权限或身份。

所有授权服务响应使用 `Cache-Control: no-store`；OAuth 错误保持标准顶层字段，例如 `{"error":"invalid_grant","error_description":"PKCE 校验失败"}`，不套用模型接口的错误对象。请求体最多 16 KiB，不允许重复表单或授权查询参数。授权接口按来源每分钟最多 120 次。

## 4. 调用模型与读取配置

```http
GET /api/integration/config
Authorization: Bearer 接入方保存的access_token
```

返回当前获准的模型及能力、相对模型端点、来源 Key 的公开权限信息和 `authorization: { id, type: "oauth", scopes }`，**不包含原始 Key、账号密码或其他上游凭据**。将返回的相对端点拼接到网关 origin，再携带同一访问令牌调用。

实际可用范围 = 用户确认时的模型权限上限 ∩ 来源 Key 当前权限。自定义范围不会因为来源 Key 后续增加模型而自动扩大；如果确认时是「全部模型」，则包含之后新增模型，同意页会明确说明。来源 Key 权限收缩立即生效，别名、大小写、分组、模态转译沿用原 Key 校验。

同一来源 Key 的直接调用和全部账号授权共享每分钟限额、请求统计与上游配额，重新授权不能绕过限流。令牌缺少 scope 返回 403；无效／过期／撤销返回 401；模型不在权限内返回 403。

访问令牌和刷新令牌均不能用于 `/api/admin/*`；即使请求来自回环或同时携带管理员 Cookie，也明确拒绝携带 OAuth 令牌的管理请求。

## 5. 刷新与撤销

刷新令牌只交给 Token 端点，不能作为模型 Bearer：

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&client_id=登记的ClientID&refresh_token=当前刷新令牌
```

在访问令牌到期前刷新即可，不要每次模型请求都刷新。**每次同时轮换访问令牌和刷新令牌，旧访问令牌立即失效**。客户端需串行刷新并原子替换保存的两种令牌；并发或重试使用旧刷新令牌会被视为重放，并撤销整条授权。换码／刷新响应丢失时应重新发起授权，不能无限重试旧令牌。绝对授权期限不随刷新延长，每条授权最多刷新 1024 次。可提交 `scope` 缩小权限，但不能扩权；移除 `offline_access` 后不再签发刷新令牌。

主动断开连接：

```http
POST /oauth/revoke
Content-Type: application/x-www-form-urlencoded

client_id=登记的ClientID&token=访问令牌或刷新令牌
```

这会撤销该授权的全部令牌。未知、已撤销、或不属于该应用的令牌也返回 200 `{}`，避免泄露令牌有效性。管理员可在后台统一查看 API Key 登记与账号授权，并手动撤销；已登录账号也可用 `GET /oauth/grants` 查看自己的授权，再同源 POST `/oauth/grants/revoke`，JSON 为 `{ "id": "授权ID" }`。

修改、停用或删除应用，停用或删除来源 Key，修改本地账号密码、停用／删除账号，或切换网关认证方式，都会使相应旧授权失效；重新启用不会恢复已撤销授权。退出浏览器登录**不等同于撤销第三方授权**。

## 持久化、备份与边界

- `oauthClients` 与 `oauthGrants` 存在 `data/config.json`；访问／刷新令牌只保存 SHA-256 哈希，未兑换的授权码和待确认请求只在内存中。
- 网关重启后，已签发且未过期的授权可以继续使用；浏览器管理会话需重新登录。
- 配置导出包含应用、账号关联、权限快照和令牌哈希，是敏感备份。默认「保留凭据」导入会保留本机授权；不保留凭据则整体采用备份的授权并清空旧登录与待确认交易。旧备份缺少 OAuth 字段时按空列表导入。
- 完整恢复历史备份也会恢复其中的撤销状态；恢复后应检查并撤销不再需要的授权。不要把生产备份复制到不可信网关。
- OIDC 账号授权依赖既有的网关登录校验，不支持第三方直接取得 OIDC ID Token。网关不会持续查询外部身份提供商的账号禁用状态；在提供商删除用户时，还应在网关撤销其已有授权。
- 适用于现有单进程网关；多副本部署不共享内存授权交易，不能在不同副本间随机分配授权请求。

## 旧 API Key 接入

保留以下接口，不需要预先登记 OAuth 应用：

| 方法 | 路径 | 内容 |
| --- | --- | --- |
| POST | `/api/integration/verify` | JSON `{ apiKey, label }`；验证后返回获准模型、端点及只展示一次的 `authorization.token` |
| GET | `/api/integration/config` | 使用原始 API Key 或 `sakura-int_` 登记令牌读取配置 |
| GET | `/api/integration/status` | 使用登记令牌查看接入状态 |
| POST | `/api/integration/revoke` | JSON `{ authorization: 登记令牌 }`；取消登记 |

再次验证可传入 `{ apiKey, label, authorization }` 更新原登记。只有 OAuth 的 `sakura-at_` 是独立模型访问令牌；旧登记令牌只能拉取配置／管理登记。若需要阻止掌握原始 API Key 的应用继续调用，应停用或删除该 Key，而不只是取消接入登记。