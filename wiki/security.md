# 认证与安全

## 双轨认证模型

网关把「管理面」与「模型调用面」完全分开：

| 面 | 接口 | 认证 | 说明 |
| --- | --- | --- | --- |
| 管理面 | `/api/admin/*`、后台页面 | 回环默认免认证（可开启「本机访问也要求登录」）/ 远程 Authentik OIDC 或本地账号密码 | 管理凭据与模型调用无关 |
| 调用面 | `/v1/*` | 本地 API Key 或 OAuth 访问令牌 | 账号授权受 scope 与来源 Key 模型权限约束，刷新令牌不能调用模型 |
| 授权面 | `/oauth/*` | 确认授权使用账号会话；Token 端点使用授权码 + PKCE 或刷新令牌 | 不共享原始 Key，不签发管理凭据 |

默认只监听 `127.0.0.1`，避免未经配置直接暴露到局域网。

## 来源识别（`admin-auth.js`）

- `normalizeAddress`：归一化 IPv4-mapped（`::ffff:x`）、IPv6 zone（`%`）、括号包裹地址。
- `isLoopbackAddress`：`::1` 及 `127.x.x.x` 判为回环。
- `requestSource`：默认**只信任 TCP socket 地址**，不信任客户端发来的 `X-Forwarded-For`。
  本机回环地址若携带转发头会标记 `untrustedForwarding: true` 并按非回环处理（防伪造）。
- 反向代理场景：把代理实际连接网关的 IP 加入 `TRUSTED_PROXY_ADDRESSES`
  （逗号分隔的精确 IP 列表），此时网关才会解析转发头，且会从右向左找到第一个非可信 IP
  作为真实来源。

## Authentik OIDC 流程

1. 未认证的远程访问先进入网关本地登录页（`/auth/login`）；用户点击登录后才访问 Authentik（`/auth/oidc/login`）。登录页本身不依赖认证服务器在线。
2. 使用 **Authorization Code + PKCE**，并携带 `state` 与 `nonce`（交易 Cookie
   `sakura_ai_gateway_oidc_state`，10 分钟有效）。
3. 回调 `/auth/oidc/callback` 校验：discovery、issuer、audience、过期时间（含 60s 时钟容差）、
   `state`/`nonce`/PKCE，以及通过 **JWKS 对 ID Token 做非对称签名校验**。
4. 校验通过后创建随机 32 字节的会话 ID，写入 **HttpOnly** Cookie
   （`sakura_ai_gateway_admin_session`），有效期 = `min(claims.exp, now + SESSION_TTL)`。
5. 会话只存在服务端内存（`Map`），**服务重启后远程会话全部失效**，需重新登录。

安全细节：

- Client Secret 只从环境变量读取，**不写入 `data/config.json` 或 Git**。
- Token 端点鉴权默认按 discovery 自动选择 `client_secret_basic` / `client_secret_post`。
- 签名校验要求非对称签名 JWT；**不支持加密的 JWE ID Token**（Authentik 不要配 Encryption Key）。
- `TRANSACTION_TTL_MS = 10min`、`DISCOVERY_TTL_MS = 1h`（discovery 有缓存）。
- 登出：清会话并调用 Authentik `end_session_endpoint`（带 `id_token_hint`）。

## 本地账号密码认证

当 `adminAuth.remoteMode` 为 `password` 时，远程管理访问改用网关自己验证的账号密码，可与 Authentik 相互切换。
账号与哈希保存在 `data/config.json` 的 `adminAuth.users`，密码使用 **scrypt（N=16384, r=8, p=1，32 字节输出，16 字节随机盐）**，
格式 `scrypt$N$r$p$saltHex$hashHex`；管理接口永不返回哈希，配置导出包含哈希但从不包含明文。
1. 未认证的远程访问先进入登录页 `/auth/login`；`remoteMode` 为 `password` 时显示账号密码表单，否则显示 Authentik 登录按钮。
2. `POST /auth/password/login` 携带 `{username, password}`；用户名用 `timingSafeEqual` 常量时间比较，密码用 scrypt 重新派生后常量时间比对。
3. 验证通过后创建与 OIDC 相同的随机 32 字节会话 ID，写入 **HttpOnly** Cookie（`sakura_ai_gateway_admin_session`），
   有效期 `AUTHENTIK_SESSION_TTL_SECONDS`（本地账号同样使用该项配置，默认 28800 秒）。
4. 会话记录登录时的 `Host`（`originHost`）；后续管理请求必须来自同一 Host，且 `Origin`/`Sec-Fetch-Site` 通过同源检查。
5. 会话只存在服务端内存，**服务重启后失效**。本地账号登出只清除本机会话，不跳转 Authentik。
6. 会话绑定账号密码版本，修改密码或停用／删除账号会使旧会话与该账号的 OAuth 授权失效；重新启用账号不会恢复已撤销的授权。

## 第三方账号授权（OAuth 2.0）

与网关向外部提供商发起的 OIDC 登录不同，这里网关是**模型资源授权服务**，第三方应用是公开客户端；不签发 ID Token，不支持密码模式或客户端凭据模式。当前复用现有管理员账号，无独立普通用户体系。

- 应用必须由管理员预先登记，回调 URL 逐字符白名单匹配，不接受通配符、URL 凭据或片段。非回环回调强制 HTTPS。
- 只支持授权码 + **S256 PKCE**，`state` 必填，回调返回 `iss`；接入方必须校验 state、issuer 并绑定自己的用户会话。
- 用户必须先通过本地账号／OIDC 登录，再在网关页面明确允许或拒绝；本机免认证不能代替登录。确认请求绑定会话、10 分钟期限、一次性 CSRF 随机值和同源 Origin。
- 授权码 2 分钟有效、只存哈希索引、仅兑换一次；绑定 Client ID、原始回调、issuer、PKCE 和账号。
- 访问令牌 1 小时有效；`offline_access` 刷新授权绝对期限 30 天。令牌使用 32 字节密码学随机数，持久化只保留 SHA-256 哈希；不会出现在网关授权日志中。
- 刷新同时轮换访问与刷新令牌，旧访问令牌失效。重用已消费的刷新令牌会撤销整条授权，客户端必须串行刷新；scope 只能缩小，不能扩大。
- 模型权限为「确认时权限快照 ∩ 来源 Key 当前权限」，沿用模型分组、别名、大小写、转译及配额规则。「全部模型」明确包含新增模型，自定义范围不自动扩大。
- 访问令牌只用于模型调用与获准配置读取。`/api/admin/*` 明确拒绝 OAuth 令牌，即使来自回环或伴随管理 Cookie；刷新令牌仅用于刷新／撤销。
- 应用修改／停用／删除、来源 Key 停用／删除、本地账号密码修改／停用／删除及登录方式切换会撤销相应授权；退出浏览器会话本身不撤销独立持续连接。
- 授权响应禁止缓存，同意页使用严格 CSP、`frame-ancestors 'none'` 和 `X-Frame-Options: DENY` 防点击劫持，`Referrer-Policy: no-referrer` 防授权参数通过 Referer 泄露。前后端共用安全回跳函数，拒绝反斜杠、控制字符、协议相对 URL 及路径归一化后的外跳。
- OAuth 请求体最大 16 KiB，拒绝重复表单／查询参数；每来源每分钟最多 120 次。尚未确认与尚未兑换的交易分别最多 1000 条。

远程授权要求 HTTPS；只接受可信代理传递的 `X-Forwarded-Proto`，不能通过伪造转发头或 OIDC 的 HTTPS 配置绕过实际协议检查。本机 HTTP 豁免同时要求回环来源和回环 Host。OIDC 模式必须使用配置的公开回调 origin。

**边界**：网关不实时查询 OIDC 提供商的账号停用状态，不支持 back-channel logout；提供商删除用户后请在网关撤销其已有授权。已开始的模型请求不会因中途撤销被强制中断，但后续请求、刷新立即拒绝。浏览器管理 Cookie 按主机而非端口隔离，因此授权流程拒绝与网关同主机名的应用回调（不同端口也拒绝）；本机可分别使用 `127.0.0.1` 和 `localhost`，生产环境使用独立域名。

接入示例、刷新并发约束与备份规则见[第三方接入指南](integration.md)。

## 本机访问也要求登录

默认情况下，来自回环地址（`127.0.0.1` / `::1`）的管理访问**免认证**——这是「本地管理访问：无需认证」的设计，
方便本机零配置打开后台。但桌面客户端、本机浏览器都走回环，导致本地账号密码在这些场景下永远用不到。

`adminAuth.requireLocalLogin`（管理后台「管理认证」页的「本机访问也要求登录」复选框）开启后：

- 仅当 **远程认证方式为本地账号密码** 且 **存在至少一个启用账号** 时才生效；
- 生效时回环访问与管理面接口同样要求登录，未登录会跳转到 `/auth/login`；
- **OIDC 模式或还没有任何账号时保持免认证**，避免把管理员锁死在本机、连创建第一个账号的机会都没有；
- 开启动作会使当前免认证的页面立即失效，前端会提示并跳转到登录页，用刚配置的账号登录即可。

桌面客户端捆绑的网关会随构建同步更新；开启本机登录前请确认客户端已更新到包含登录页的版本。

防暴力破解：

- 同一来源 5 分钟内连续失败 5 次，锁定该来源 60 秒（`loginFailures` 内存计数），锁定期间即使密码正确也返回 429。
- 失败响应统一「用户名或密码错误」，不区分用户名是否存在。
- scrypt 单次校验本身耗时约数十毫秒，进一步拖慢批量猜测。


## 本地 API Key

- 创建于后台，`sk-local_<随机>` 格式；可重命名、启用/停用。
- 停用立即生效（模型请求返回 401）；**系统至少保留一个可管理的 Key**，不允许删除最后一个。
- 完整 Key 只在已认证的管理后台可见/可复制；上游 API Key 始终掩码显示
  （`maskSecret`：保留首尾各 4 字符，其余打点）。

## 限流与并发

- 全局并发上限 `maxConcurrentRequests`（0 不限）。
- 每 Key 每分钟请求上限 `requestsPerMinute`（0 不限）。
- 被拒请求返回 `429` + `Retry-After` + `x-request-id`，不消耗并发槽与每分钟配额。
- 仅作用于模型调用接口，不影响 `/v1/models` 与管理接口。

## 数据文件安全

| 文件 | 敏感程度 | 保护方式 |
| --- | --- | --- |
| `data/config.json` | 含上游/本地 Key、账号哈希、OAuth 令牌哈希与权限记录 | 0600 权限、原子写（`.tmp` + rename）、已 `.gitignore` |
| `data/metrics.json` | 脱敏元数据 | 0600、已 `.gitignore` |
| `data/metrics-log.jsonl` | 脱敏元数据 | 0600、追加写入、已 `.gitignore` |
| Authentik Client Secret | 高 | 仅环境变量，永不落盘 |

> ℹ️ `.gitignore` 覆盖 `data/config.json`、`data/metrics.json`、`data/metrics-log.jsonl`、
> `data/*.tmp` 与 `*.log`，运行时数据不会被误提交。

配置导出包含 OAuth 授权的哈希与撤销状态，属于敏感备份。默认保留凭据导入沿用本机授权；完整恢复会采用备份记录，**可能恢复备份时尚未撤销的授权**，恢复后应审查。旧备份没有 OAuth 字段时按空列表处理。网关重启会清除待确认请求、授权码和登录会话，但不清除仍有效的已签发令牌记录；当前只适用于单进程部署。

## 反向代理与 HTTPS

- 使用 `HOST=0.0.0.0` 暴露时：远程管理访问必须配置本地账号或 OIDC；模型接口需要本地 Key 或 OAuth 访问令牌。
- 远程账号授权必须使用 HTTPS，建议同时设置防火墙与网络访问控制。
- 若经 Nginx/Caddy/Traefik 反代：把代理 IP 加入 `TRUSTED_PROXY_ADDRESSES`；
  保留公开 Host 并设置 `X-Forwarded-For`、`X-Forwarded-Proto: https`。OIDC 会话 Cookie 的 `Secure` 属性按回调 URL 是否 HTTPS 自动决定；本地账号部署也应设置 `AUTHENTIK_COOKIE_SECURE=true`，生产环境不要强制关闭。
