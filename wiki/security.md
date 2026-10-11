# 认证与安全

## 双轨认证模型

网关把「管理面」与「模型调用面」完全分开：

| 面 | 接口 | 认证 | 说明 |
| --- | --- | --- | --- |
| 管理面 | `/api/admin/*`、后台页面 | 回环默认免认证（可开启「本机访问也要求登录」）/ 远程 Authentik OIDC 或本地账号密码 | 管理凭据与模型调用无关 |
| 调用面 | `/v1/*` | 本地 API Key | 无论本机还是远程都要 Key |

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
| `data/config.json` | 含上游/本地 Key | 0600 权限、原子写（`.tmp` + rename）、已 `.gitignore` |
| `data/metrics.json` | 脱敏元数据 | 0600、已 `.gitignore` |
| `data/metrics-log.jsonl` | 脱敏元数据 | 0600、追加写入、已 `.gitignore` |
| Authentik Client Secret | 高 | 仅环境变量，永不落盘 |

> ℹ️ `.gitignore` 覆盖 `data/config.json`、`data/metrics.json`、`data/metrics-log.jsonl`、
> `data/*.tmp` 与 `*.log`，运行时数据不会被误提交。

## 反向代理与 HTTPS

- 使用 `HOST=0.0.0.0` 暴露时：远程管理访问必须完整配置 Authentik；模型接口仍需本地 Key。
- 建议同时使用 HTTPS、防火墙与网络访问控制。
- 若经 Nginx/Caddy/Traefik 反代：把代理 IP 加入 `TRUSTED_PROXY_ADDRESSES`；
  会话 Cookie 的 `Secure` 属性按回调 URL 是否 HTTPS 自动决定，生产环境不要强制关闭。
