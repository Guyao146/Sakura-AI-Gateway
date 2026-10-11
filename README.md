# Sakura-AI-Gateway

官方仓库：[Guyao146/Sakura-AI-Gateway](https://github.com/Guyao146/Sakura-AI-Gateway)。
从改名前版本升级请先阅读[名称与数据迁移说明](wiki/migration.md)，尤其是 Docker 数据卷与桌面客户端数据目录。

> 📚 **Wiki 文档**：
> - 服务器/浏览器浏览：[`wiki/index.html`](wiki/index.html)（自包含阅读器，切页自动回到顶部；需通过 http 访问）
> - 源码版：[`wiki/index.md`](wiki/index.md) —— 包含架构与模块、接口参考、模型路由与轮询池、指标与请求日志、认证与安全、部署与配置、开发与测试。

一个运行在本机的轻量模型聚合网关。它不依赖 npm 第三方包，使用 Node.js 内置 HTTP 服务和 `fetch`，可以把本地客户端的 OpenAI / Anthropic 请求转发到多个可配置的上游站点。

## 当前功能

- OpenAI 兼容接口：`POST /v1/chat/completions`、`GET /v1/models`
- OpenAI Responses 兼容接口：`POST /v1/responses`
- OpenAI Responses 原生透传，保留 Codex、Computer Use、Shell、Apply Patch 等 Agent 工具、状态字段和 SSE 事件
- Anthropic 兼容接口：`POST /v1/messages`
- OpenAI ↔ Anthropic 请求、响应和 SSE 流式响应转换
- 流式响应保持统一的响应 ID，支持文本增量、结束事件和上游返回的 usage 统计
- 后台添加、编辑、删除、测试上游站点，并支持单个或批量按需查询余额
- 上游协议支持 OpenAI 兼容和 Anthropic；支持 Bearer、`x-api-key`、无鉴权
- 本地模型名到上游模型名的路由映射，支持 `*` 兜底路由
- 路由支持备用上游；主上游连接失败、超时、429 或 5xx 时按顺序切换
- 请求统计和最近请求元数据，可查看成功率、故障转移次数、Token 数量及按上游统计；请求日志支持按关键字、本地 API Key 和时间段组合筛选，关键字可检索客户端内容摘要
- 路由支持故障转移、轮询、加权轮询和随机四种策略
- 添加上游时填写地址和 API Key 即可从 `/v1/models` 拉取并回填模型列表
- 已保存的上游支持从 `/v1/models` 同步模型列表
- 余额查询支持 NewAPI Token Usage、常见额度字段和 Sub2API 平台额度响应；结果仅缓存在内存中
- 模型目录会合并不同上游的同名模型，并支持按前缀展开/收起、搜索和复选框选择
- 同名模型可自动轮询所有健康来源站，也可通过下拉框固定某一个站点
- 可为每个模型设置本地别名、默认思考强度和接口协议（Chat Completions 或 Responses）
- 思考强度支持“遵循客户端设置”，选择该项时网关不注入默认思考参数，由客户端显式参数决定
- 支持“拉取思考强度”：对上游未声明档位的模型发送极小探测请求，确认真实支持的低/中/高档位
- 管理后台的上游、路由和本地 Key 卡片支持拖拽排序，顺序保存在当前浏览器中
- 管理页面支持 F5 刷新；请求统计可导出最近 100 条或当前保留的全部用量记录
- 每个模型的自动站点池可调整使用优先级，优先顺序随模型选择一起保存
- 请求统计面板每 5 秒自动刷新，不会重新加载配置或打断模型选择草稿
- 后台支持检查 GitHub Release；正式 Release 包含 SHA-256 digest 时可备份 `data/` 后自动升级并重启
- 支持从上游模型元数据识别 reasoning/thinking 能力，并转换思考参数
- 管理后台按访问来源认证：本机回环访问免认证，远程访问可使用外部 OIDC 提供商统一登录或本地账号密码，两者可在后台随时切换
- OIDC 使用 Authorization Code + PKCE、state、nonce、JWKS 签名校验和 HttpOnly 会话
- 本地账号密码使用 scrypt 加盐哈希，登录带来源失败锁定；会话绑定登录时的访问来源
- 本地 API Key 管理
- 本地 API Key 支持启用/停用和重命名，至少保留一个可管理的 Key
- 每个 Key 可独立设置允许的模型分组与组内模型：进入「本地调用 Key → 新建/编辑 → 自定义分组与模型」，启用分组后逐个勾选或组内全选。分组沿用目标模型 ID 的前缀，别名独立授权；新同步模型不会自动加入权限。旧 Key 默认允许全部模型，自定义为空则禁止全部模型；模型列表与 Chat / Messages / Responses 调用均受限制。
- 可配置上游超时、每个上游的重试次数、备用尝试次数和切换前等待时间
- 每次模型请求返回 `x-request-id`，启动转发前在网关控制台输出该 ID，并把同一 ID 传递给上游；错误响应也会连同 ID 输出到控制台和后台日志
- 上游健康状态和内存熔断：连续失败达到阈值后暂时跳过，冷却后自动半开探测
- 配置保存在 `data/config.json`，该文件已加入 `.gitignore`
- 默认只监听 `127.0.0.1`，避免未经配置暴露到局域网

## Windows 客户端

仓库包含两种桌面客户端：

- `clients/webview2`：.NET 8 WinForms + Microsoft Edge WebView2；客户端目录内带有官方
  Node.js 20 Windows x64 runtime，网关配置保存在当前用户的 LocalAppData，不会随程序升级覆盖。
- `clients/electron`：Electron + electron-builder；Electron 自带运行时，网关配置保存在 Electron
  的 userData 目录。

推送 `vX.Y.Z` tag 后，GitHub Actions 会在 Windows runner 上编译并创建同一个 GitHub Release，
制品名称带有技术栈后缀：

```text
Sakura-AI-Gateway-X.Y.Z-WebView2-win-x64.zip
Sakura-AI-Gateway-X.Y.Z-Electron-win-x64-Setup.exe
Sakura-AI-Gateway-X.Y.Z-Electron-win-x64-Portable.exe
```

WebView2 客户端要求 Windows 已安装 Microsoft Edge WebView2 Runtime；Electron 客户端不要求
额外安装 Electron。网关源码升级包另为 `Sakura-AI-Gateway-vX.Y.Z.tar.gz`。

桌面客户端会为内嵌网关自动选择空闲的 `127.0.0.1` 端口，并覆盖旧配置中的监听端口，避免
以前手动运行网关留下的 `data/config.json` 导致客户端白屏或连接到错误端口。

## 启动

需要 Node.js 18 或更高版本（当前服务使用 Node 18+ 内置 `fetch`）。在 Windows PowerShell 中：

```powershell
cd "D:\VSProject\Sakura-AI-Gateway"
node src/server.js
```

如果 PowerShell 的执行策略阻止 `npm.ps1`，本项目不需要 npm 安装依赖，直接使用 `node src/server.js` 即可。也可以使用：

```powershell
npm.cmd start
```

启动时终端会打印默认本地 API Key：`sk-local_...`。打开 <http://127.0.0.1:8787/> 后，本机回环访问会自动进入后台，不需要输入任何管理凭据。

管理认证与模型调用认证彼此独立：

- 管理后台和 `/api/admin/*`：本机回环访问免认证；远程访问需要登录，可在后台「访问控制 → 管理认证」里选择外部 OIDC 提供商统一登录或本地账号密码
- `/v1/*` 模型接口：无论本机还是远程，仍然必须使用后台创建的本地 API Key

## 本地账号密码认证（可与外部 OIDC 提供商切换）

如果不想部署独立的 OIDC 提供商，也可以让网关自己验证管理账号密码。两种远程认证方式可以随时切换：

- 本机回环访问默认免认证；只有远程访问管理后台时才需要登录（也可以在后台开启「本机访问也要求登录」，见下文）
- 密码使用 scrypt（含随机盐）哈希后保存在 `data/config.json`，明文不会回传前端，也不会写入请求日志
- 登录接口带来源失败锁定：同一来源 5 次失败后锁定 60 秒
- 模型调用接口不受影响，仍使用本地 API Key

### 1. 创建账号并切换认证方式

1. 在网关所在本机打开 <http://127.0.0.1:8787/>（回环访问免认证）
2. 进入「访问控制 → 管理认证」，点击「＋ 新建账号」创建第一个管理员账号
3. 选择「本地账号密码」并点击「保存认证方式」

之后远程访问网关首页会进入登录页，输入账号密码即可进入后台。需要换回统一登录时，在同一面板选择「外部 OIDC 提供商」保存即可（前提是已配置下面的环境变量）。

### 2. 让本机访问也要求登录

桌面客户端和本机浏览器都走回环地址，默认免认证。如果希望本机打开后台也要登录，在「管理认证」面板勾选「本机访问也要求登录」再保存即可：

- 仅在「本地账号密码」模式下、且至少存在一个启用账号时生效；
- 还没有任何账号时不会生效，保留创建第一个账号的入口；
- 保存后当前页面会立即失效，跳转到登录页，用刚配置的账号登录即可；
- OIDC 模式下不生效（避免外部 OIDC 提供商不可用时把管理员锁死在本机）。

也可以在启动时用环境变量直接指定初始认证方式：

```powershell
$env:ADMIN_REMOTE_MODE = "password"   # 或 oidc（默认）
```

> 注意：`ADMIN_REMOTE_MODE` 只决定启动时使用的模式；在后台切换后会以配置文件为准。

### 2. 管理员账号约定

- 用户名 3 到 32 个字符，可用字母、数字以及 `. _ @ + -`
- 密码至少 8 个字符，不能包含空白字符
- 账号可启用/停用；本地账号模式下至少保留一个启用账号
- 编辑账号时密码留空表示不修改；密码以哈希存储，无法找回明文，只能重新设置

## 外部 OIDC 提供商统一登录（远程管理认证）

### 1. 在外部 OIDC 提供商创建 Provider 和 Application

创建一个 OAuth2/OpenID Provider，并建议使用：

- Client type：`Confidential`
- Authorization flow：`Authorization Code`
- Redirect URI：你的公网网关地址加 `/auth/oidc/callback`，例如 `https://gateway.example.com/auth/oidc/callback`
- Scopes：`openid profile email`
- Signing Key：建议选择证书密钥，让 ID Token 使用非对称签名并通过 JWKS 校验
- Encryption Key：不要配置；当前网关验证签名 JWT，不支持加密的 JWE ID Token

然后创建 Application 并绑定该 Provider。哪些用户或组能进入后台，应通过提供商 Application 的 Policy/Binding 控制；只要用户能通过这个 Application 的认证，就拥有网关管理权限。

Issuer URL 使用该 Application 的 OIDC issuer，通常格式为：

```text
https://auth.example.com/application/o/<application-slug>
```

不要在 `AUTHENTIK_ISSUER_URL` 末尾填写 `/.well-known/openid-configuration`，网关会自动请求 discovery 地址。

### 2. 配置环境变量

OIDC Client Secret 只从环境变量读取，不会写入 `data/config.json` 或 Git。Windows PowerShell 示例：

```powershell
$env:HOST = "0.0.0.0"
$env:AUTHENTIK_ISSUER_URL = "https://auth.example.com/application/o/sakura-ai-gateway"
$env:AUTHENTIK_CLIENT_ID = "在外部 OIDC 提供商中生成的 Client ID"
$env:AUTHENTIK_CLIENT_SECRET = "在外部 OIDC 提供商中生成的 Client Secret"
$env:AUTHENTIK_REDIRECT_URI = "https://gateway.example.com/auth/oidc/callback"
node src/server.js
```

远程用户访问 `https://gateway.example.com/` 时会先进入网关自身的登录页，再由用户选择跳转外部 OIDC 提供商。登录页和会话状态检查不依赖提供商响应，因此认证服务临时不可用时仍能显示明确错误并重新尝试，不会只留下超时或空白页面。认证成功后，网关验证 discovery、issuer、audience、过期时间、state、nonce、PKCE 和 ID Token 签名，并创建仅服务端保存的 `HttpOnly` 会话。服务重启后远程会话失效，需要重新登录。

### 3. 反向代理与来源判断

网关默认只根据 TCP socket 的来源地址判断本地或远程，不会直接信任客户端发送的 `X-Forwarded-For`。如果使用 Nginx、Caddy 或 Traefik 反向代理，必须把代理实际连接网关时使用的 IP 明确加入 `TRUSTED_PROXY_ADDRESSES`，多个地址用逗号分隔。例如代理与网关都在本机：

```powershell
$env:TRUSTED_PROXY_ADDRESSES = "127.0.0.1,::1"
```

反向代理必须覆盖而不是盲目透传客户端提供的来源头。例如 Nginx：

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

如果不使用反向代理、远程客户端直接连接网关，不要设置 `TRUSTED_PROXY_ADDRESSES`。该变量只接受精确 IP 地址，不接受主机名或 CIDR。错误地信任客户端可以直接连接的地址会造成认证绕过风险。

> 注意：如果同机反向代理连接 `127.0.0.1`，但没有配置 `TRUSTED_PROXY_ADDRESSES`，网关看到转发头时会拒绝把该连接当作本地访问，并要求完成统一登录，防止远程请求被错误地免认证。

本机免认证访问请使用 `http://127.0.0.1:8787/`、`http://localhost:8787/` 或 IPv6 回环地址。管理后台会校验回环 Host、Origin 和浏览器来源信息，防止 DNS Rebinding 或跨站页面利用本机免认证权限修改配置。

## 配置上游

### sub2api / newapi 类 OpenAI 兼容站点

通常填写：

- 地址：站点的 API 根地址，例如 `https://example.com/v1`
- 协议：`OpenAI 兼容`
- 鉴权：`Bearer`
- API Key：该站点的 Key
- 客户端兼容标识：默认不覆盖；遇到站点按客户端区分兼容性时可选择预设或自定义 `User-Agent`
- 余额接口路径：通常留空自动探测；私有站点可填写同源相对路径
- 模型列表：填写地址和 API Key 后可点击“拉取模型”自动获取，也可以每行手工填写一个

如果站点明确要求 `x-api-key`，把鉴权方式改为 `x-api-key`。

### 客户端兼容标识

每个上游可以独立选择客户端兼容标识，应用于模型调用、连接测试、模型拉取和余额查询：

- 默认：不主动覆盖 `User-Agent`，由 Node.js `fetch` 使用自身默认值
- Claude Code：发送 `User-Agent: claude-code`
- OpenAI Codex CLI：发送稳定标识 `User-Agent: codex_cli_rs` 和 `originator: codex_cli_rs`；官方完整 UA 还会动态包含版本、系统、架构和终端信息，需要精确值时请使用自定义模式
- Cherry Studio：发送 `User-Agent: CherryStudio`
- 自定义：发送用户填写的 `User-Agent`

该功能只用于兼容需要识别客户端类型的上游，不会修改 `Authorization`、`x-api-key` 或 `Host`，也不会伪造动态会话头、设备证明、账号签名或 attestation。自定义值最长 300 个字符并拒绝 CR/LF、Tab 等控制字符，避免请求头注入。请仅在上游服务条款允许的情况下使用；它不能替代站点授权，也不保证绕过服务端的完整客户端校验。

### 查询上游余额

上游卡片中的“查询余额”只查询当前站点，“查询全部余额”会以最多 4 个并发查询所有上游。查询使用上游现有的 Bearer、`x-api-key` 或无鉴权设置，不会修改模型请求的健康状态或触发熔断。

- 留空“余额接口路径”时，会自动尝试 NewAPI 的 `/api/usage/token` 和 Sub2API 的 `/api/v1/user/platform-quotas`。
- NewAPI `/api/usage/token` 返回的是站点内部额度单位，后台会显示为“额度”，不会擅自换算为美元。
- Sub2API 的 `daily_*_usd`、`weekly_*_usd`、`monthly_*_usd` 字段会按 USD 展示，并计算各窗口剩余额度。
- 部分 Sub2API 或私有站点的账户额度接口只接受面板 JWT，不接受模型 API Key；这种情况会显示查询失败或不支持。可以填写站点提供的同源余额接口路径，但当前不会额外保存面板登录凭据。
- 自定义路径必须以 `/` 开头，且只能访问当前上游同源地址；不接受完整 URL、查询参数或片段。
- 查询结果和失败原因仅保存在进程内存中，重启后需要重新查询；不会写入 `data/config.json`，也不会把上游原始响应返回给浏览器。

### Claude / Anthropic 上游

填写：

- 地址：站点 API 根地址，例如 `https://example.com` 或 `https://example.com/v1`
- 协议：`Anthropic`
- 鉴权：默认 `x-api-key`
- API Key：该站点的 Key

网关会请求上游的 `/v1/messages`，并自动转换 system、文本、工具调用以及流式事件。

## 配置路由

例如将本地客户端请求的 `claude-3-5-sonnet` 转发为某个上游实际模型：

- 本地模型名：`claude-3-5-sonnet`
- 上游：选择目标站点
- 上游模型名：`claude-3-5-sonnet-20241022`

路由优先级：精确路由 → `*` 兜底路由 → 上游模型列表匹配 → 仅有一个启用上游时自动转发。

路由可以配置多个备用上游。非流式请求在主上游连接失败、请求超时、返回 408/425/429 或 5xx 时，会依次尝试备用上游；如果上游已经返回 4xx 参数或鉴权错误，网关不会自动换站点掩盖配置问题。流式请求也只会在建立上游响应之前切换，一旦开始向客户端输出内容就不会中途重试，避免重复生成内容。

路由的分流策略可以选择：

- `failover`：按主上游和备用上游顺序尝试，旧路由默认使用此策略
- `round_robin`：健康候选上游轮询分配
- `weighted`：按路由中配置的正整数权重进行平滑加权轮询
- `random`：从健康候选上游中随机选择

轮询、加权和随机策略仍会在选中的上游失败时尝试本次请求的其它候选；熔断中的上游不会参与分流。策略游标只存在内存中，重启后重新开始。

## 本地客户端调用

### OpenAI SDK / OpenAI 兼容 APP

Base URL 填：

```text
http://127.0.0.1:8787/v1
```

API Key 填后台创建的本地 Key，模型名填配置的“本地模型名”。例如：

```bash
curl http://127.0.0.1:8787/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer sk-local_xxx" ^
  -d "{\"model\":\"claude-3-5-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

### Anthropic 兼容 APP

Base URL 同样填：

```text
http://127.0.0.1:8787/v1
```

请求 `POST /v1/messages`，使用本地 API Key 作为 `x-api-key` 或 Bearer Token。网关会根据模型路由选择上游。

### OpenAI Responses API

支持常见的 Responses 请求字段 `input`、`instructions`、`max_output_tokens`、`tools` 和 `stream`。OpenAI 上游默认优先使用原生 `/v1/responses`；普通请求在自动模式下可于原生端点不可用时兼容回退。Agent 专有字段以及“function tools + 非 `none` 的 `reasoning_effort`”必须使用原生 Responses，禁止有损回退到 `/v1/chat/completions`。非流式示例：

客户端调用网关的 `/v1/chat/completions` 时，自动或 Chat 模式保持使用上游 Chat 接口，function tools 与 `reasoning_effort` 可以同时传递，不会因为开启思考切换协议。显式选择 `native`（Responses）模式时，网关才将 Chat 请求转换到 `/v1/responses`，再将结果转回 Chat；工具输出项 ID、调用 ID 和输出序号会关联到同一个 Chat 工具 index，保证工具首帧携带字符串 ID。

```bash
curl http://127.0.0.1:8787/v1/responses ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer sk-local_xxx" ^
  -d "{\"model\":\"gpt-4o\",\"instructions\":\"Be concise\",\"input\":\"你好\",\"max_output_tokens\":100}"
```

Responses 流式请求会返回 `response.created`、`response.output_text.delta`、`response.output_text.done` 和 `response.completed` 等 SSE 事件。当前版本重点兼容文本输出；如果上游在流中返回 usage，网关会同步到后台统计。复杂的 Responses 专有事件和部分高级工具事件会在后续继续扩展。

## 配置备份和恢复

后台“配置备份”区域可以导出完整 JSON 配置，也可以从备份文件导入上游和路由。导入默认保留当前机器的本地 API Key；备份中的完整上游 API Key 会恢复，掩码 Key 会尝试使用当前相同上游 ID 的 Key。旧备份中的管理员 Token 字段仅为格式兼容保留，不再参与后台认证。监听地址或端口导入后需要重启服务才会生效。

## 请求统计和模型同步

后台的“请求统计”区域会显示请求总数、成功率、故障转移次数、输入/输出/总 Token、按上游统计以及请求元数据日志。日志默认保留最近 5000 条（可用环境变量 `SAKURA_AI_GATEWAY_MAX_LOGS` 调整，最少 100），页面先显示最新 100 条，点击“加载更多”按 100 条为一页向下翻。从 v2.0.7 起，每条日志还会带一份**请求诊断**（点该行即可展开）：网关实际发给上游的请求体、上游返回与网关输出的前若干帧样本，以及自动修正过的异常（例如上游返回了非字符串 id）。这些样本用于排查协议转换问题，因此会包含消息内容，但**不会**包含请求头、API Key 或上游完整地址（只记录路径，如 `/v1/responses`）；每个字段都做了长度截断。可以在后台点击“清空统计”。聚合计数保存在 `data/metrics.json`，请求日志以追加写入的方式保存在 `data/metrics-log.jsonl`（旧版内联日志会在首次启动时自动迁移），与上游配置分开保存。

添加或编辑上游时，填写地址和 API Key 后可以直接点击“拉取模型”，网关会调用该站点的 `/v1/models` 并把模型 ID 回填到表单；确认列表后仍需点击“保存上游”。编辑已有上游时 API Key 可以留空，拉取会安全复用已保存的 Key。已保存的上游卡片也提供“同步模型”按钮。部分 Anthropic 上游没有标准模型列表接口，此时仍需手工填写模型。

## 模型目录和本地模型选择

### 输入模态与转译

每行「拉取能力」会刷新各来源站的模型元数据，并仅为当前模型补充思考强度探测（上游已声明时跳过，探测可能收费）。拉取全部模型同样读取模态声明。界面按来源站显示输入/输出模态，路由时以实际候选站的能力为准，不使用合并后的并集进行校验。

- 识别 `input_modalities` / `output_modalities`、驼峰写法、`supported_input_modalities` / `supported_output_modalities`、`capabilities`、`modalities.input/output`、OpenRouter 风格 `architecture.input_modalities/output_modalities` 与 `architecture.modality`（如 `text+image->text`）。`vision`、`supports_image` 等布尔声明只影响对应模态。
- 上游未声明的能力显示**未知**，不是“纯文本”。未知时保持原有透传行为；不根据模型名称或 HTTP 200 猜测视觉能力，不自动发图片/音频付费探测。同步缺少字段或失败时保留原有结论，新声明覆盖旧声明。
- 在模型行或手工路由中选择「模态转译模型」（一个已启用的本地模型名/别名）。确认目标不支持某个附件时，先将该附件单独发送给转译模型，再用标记过的文字记录替换原位置。其他文字、工具调用和消息顺序不变。同一请求的重复附件复用转译结果，目标仍可流式输出。
- 留空则返回 `400 unsupported_input_modality`；Key 必须同时有权访问目标与转译模型，否则 `403 model_not_allowed`。转译模型必须明确支持该输入，不能自引用，也不会递归调用它的转译配置。删除/停用转译模型后返回配置错误。
- 支持检查 Chat、Messages、Responses 中的图片、音频、视频、文件块及工具结果内附件。图片有跨协议转换；其他媒体优先使用同协议上游，无法无损转换时明确报错，绝不静默删除。跨上游的 `file_id` 不可转译，应改传文件内容/URL；只处理本次请求显式携带的附件，不读取 Responses 历史状态。
- **费用与隐私：**附件会发送给所选转译模型，产生额外费用与延迟，文字记录可能有误或丢失细节。转译不发送完整对话、不启用工具；单次最多转译 16 个附件，每个最多输出 4096 tokens，超时上限 120 秒（更短的上游超时仍生效），空结果、截断或失败返回 502，不再调用目标模型。转译请求单独计入统计，日志 ID 带 `-translation-`，不包含额外的附件诊断样本。仅支持输入转为文本，**不生成或转译图片/音频输出**；目标明确不支持请求的输出模态时返回 400。

能力字段与 `modalityTranslator` 均会持久化，并随配置导出/导入保留。转译模型可先创建为手工路由或保存为已选择模型，再为目标配置。

后台“本地模型选择”区域会先按模型 ID（忽略大小写）合并所有来源站，再按模型 ID 前缀分组展示。前缀默认收起。前缀取模型 ID 中第一个 `-`、`_`、`:` 或 `/` 之前的部分，例如 `gpt-4o` 归入 `gpt`、`claude-3-7-sonnet` 归入 `claude`。大小写不同的拼写视为同一个模型，合并成一行并以「当前名称」显示，转发时按各站自己的拼写发送。可以：

- 点击“拉取全部模型”尝试从所有启用上游的 `/v1/models` 获取模型；不提供该接口的 Anthropic 站点继续使用上游表单中的手工模型
- 使用搜索框按站点名、模型 ID 或显示名筛选
- 点击前缀标题展开、收起，也可以使用顶部“全部展开/全部收起”控制所有前缀
- 按单个模型前缀“全部勾选/全部取消”
- 勾选要暴露给本地 APP 的模型
- 同一个模型 ID 在多个站点存在时，从行内下拉框选择“自动选择”或固定某一个来源站；选“自动选择”后会出现“轮询站点”勾选框，可以只勾选想参与轮询的上游（至少保留两个，全部取消时自动回退为全部站点）
- 给模型设置本地别名
- 为每个模型设置默认思考强度：自动、关闭、低、中、高
- 为每个模型设置接口协议偏好：`auto`（默认，按上游支持情况自动选择）、`native`（强制 `/v1/responses`）、`chat`（强制 `/v1/chat/completions`）。该设置覆盖上游的 `responsesMode`，适合同一个站点上不同模型走不同协议的场景；选 `native` 时即使上游返回 404/405/501 也不会悄悄回退到 Chat Completions

新勾选的同名模型默认使用“自动选择”：网关会为所有提供该模型的站点创建轮询候选池，只在启用且未熔断的站点之间分配请求；连接失败、超时、408/425/429 或 5xx 时仍会尝试本次请求的其它候选。选择具体站点则只使用该站。旧配置中的单站选择会继续显示为固定站，不会在未保存时改变行为；重新选择“自动选择”并保存后才会启用候选池。

点击“保存勾选”后，网关会自动创建或更新选择器管理的本地路由；同名模型只保留一个选择器路由。旧版按站点重复保存的同名选择会自动合并为候选池，并保留第一条记录的本地别名；导入旧备份时也会删除多余的旧托管路由。原有手工路由不会被覆盖。进入选择器模式后，`/v1/models` 只展示勾选的本地模型和手工路由，不再展示未勾选的上游原始模型。取消所有勾选也会生效，表示只保留手工路由。

思考强度的转换规则：

- **Responses 出站始终发送 `reasoning: { effort: "none" }`**，覆盖客户端、路由和模型默认思考强度，并移除 `reasoning_effort` / `thinking` 冲突字段。
- 自动接口模式会识别接口不支持、function tools 与思考参数不兼容等错误，在同一已配置上游尝试 Chat / Responses / Messages；持续服务失败会触发按模型、接口隔离的冷却（默认连续 3 次、60 秒）。显式锁定接口、鉴权/普通参数错误不盲目切换；已输出的流不重放。详见 [接口智能切换与冷却](wiki/routing.md#接口智能切换与冷却)。
- OpenAI Chat 兼容上游：低/中/高转换为 `reasoning_effort: low/medium/high`
- 上游声明的 `none / minimal / xhigh` 也会保留、显示并可选，支持档位数组及 `reasoning.effort.enum` / `reasoning.supported_efforts` 等形式；Chat 按原档位发送，Responses 固定 `none`。`none` 会显式发送，和「关闭（剥离思考参数）」不同。主动探测仍只试低/中/高三档，不凭空补全额外档位
- Anthropic 上游：低/中/高转换为 `thinking: { type: "enabled", budget_tokens: 2048/4096/8192 }`
- Anthropic 的预算映射不支持 `none / minimal / xhigh` 这些默认档位，配置后返回明确错误，不会偷偷改成中档；可改用低/中/高或遵循客户端
- 自动：不主动添加思考参数
- 上游明确声明不支持思考时：不会添加思考参数
- 上游能力未知时：后台仍允许配置；如果客户端没有显式思考参数，网关会按选择的强度尝试发送
- 客户端请求显式提供 `reasoning_effort` 或 `thinking` 时，优先使用客户端值
- 参数形态与目标端点自动匹配：发往 `/v1/responses` 的一律使用 `reasoning: { effort }`，发往 `/v1/chat/completions` 的一律使用 `reasoning_effort`，客户端传入的另一种形态会被转换，避免上游以「调用的接口类型和传入的参数不匹配」拒绝请求

网关会识别常见的模型能力字段，包括 `supports_thinking`、`supports_reasoning`、`thinking_levels`、`reasoning_effort`、`capabilities.thinking`、`supported_parameters` 等；部分常见 Claude 3.7/4、o1/o3/o4、GPT-5 模型也会按模型名做保守推断。不同站点的私有字段可能需要后续适配。

上游没给档位时，可以点模型目录工具栏的「拉取思考强度」（或在某个上游卡片上点「探测思考」）主动确认：

- 网关对每个能力未知的模型逐档发送 `reasoning_effort: low/medium/high` 探测请求；OpenAI 兼容上游用 `max_tokens: 1`，Anthropic 上游取协议允许的最小思考预算（`budget_tokens: 1024`）
- 已由上游元数据声明过能力的模型会跳过，不会重复消耗额度；也可以只对单个上游重新探测
- 只有上游确实接受的档位才会保留，模型行会显示「支持思考 + 低/中/高」和「探测」标记；探测为不支持时网关不会向该模型发送思考参数
- 连接失败、超时、429 与 5xx 视为「没能得出结论」，会保留原有判断，不会把不确定写成不支持
- 探测请求不写入请求统计、不触发熔断；结论写入配置文件，重新同步模型也不会被抹掉
- 之后该模型的思考强度下拉只列出探测到的档位；此前保存过但上游未探测到的档位仍会保留并标注，不会静默改写你的选择

## 可靠性设置和 Key 管理

后台“可靠性设置”可以调整：

- 上游超时：1000 到 3600000 毫秒，默认 600000 毫秒
- 每个上游重试次数：0 到 10 次，默认 0。某个上游出现连接失败、超时、429 或 5xx 时，先原地重试同一个上游这么多次，仍失败才切换到下一优先级的备用上游；4xx 参数/鉴权类错误不重试也不切换，直接返回
- 最大备用尝试次数：0 表示不限制；1 表示主上游失败后最多再尝试 1 个备用
- 切换前等待：0 到 30000 毫秒
- 熔断失败阈值：1 到 20 次，默认 3 次
- 熔断冷却时间：1000 到 3600000 毫秒，默认 60000 毫秒
- 最大并发请求数：0 表示不限制，范围 0 到 1000
- 每 Key 每分钟请求数：0 表示不限制，范围 0 到 10000
- 错误消息前缀：最长 60 个字符，默认为空。JSON 和 SSE 错误消息统一为 `自定义前缀 [request_id=请求ID] [code=错误码] 原始报错内容`，例如 `[SakuraGateway] [request_id=req_xxx] [code=400] model 不能为空`。错误码优先使用上游 `code`，缺失时使用 HTTP 错误状态码；流内错误没有 HTTP 错误状态时用 `502`，不把 `type` 或握手的 `200` 当成错误码。留空只省略自定义前缀，请求 ID 和错误码仍显示；成功响应及正常流式内容不受影响

本地 Key 的完整值可以在已认证的管理后台直接查看和一键复制，也可以编辑名称、启用或停用。停用会立即使该 Key 的模型请求返回 401；系统不允许删除最后一个本地 Key。

后台上游卡片会显示健康状态、连续失败次数和熔断冷却时间。熔断状态只存在内存中，网关重启后会清除；也可以点击“重置状态”立即恢复该上游。熔断失败阈值默认是 3 次，冷却时间默认是 60000 毫秒。

每次 `/v1/chat/completions`、`/v1/messages` 或 `/v1/responses` 请求都会返回 `x-request-id`。如果客户端自己提供符合格式的 `x-request-id`，网关会沿用它并传给上游；否则自动生成一个。后台请求日志也会保存这个 ID。

限流只作用于模型调用接口，不影响 `/v1/models` 和管理接口。并发限制是全局模型请求数；每分钟限制按本地 API Key 独立计算。被拒绝请求返回 HTTP 429、`Retry-After` 和 `x-request-id`，不会消耗并发槽或每分钟配额。

## 环境变量

- `HOST`：监听地址，默认 `127.0.0.1`
- `PORT`：监听端口，默认 `8787`
- `SAKURA_AI_GATEWAY_DATA_DIR`：可选，指定配置数据目录；默认是项目下的 `data`
- `ADMIN_REMOTE_MODE`：可选，远程管理认证方式，`oidc`（默认）或 `password`；在后台切换后以配置文件为准
- `AUTHENTIK_ISSUER_URL`：外部 OIDC 提供商 Application 的 OIDC issuer URL
- `AUTHENTIK_CLIENT_ID`：外部 OIDC 提供商 OAuth2/OpenID Provider 的 Client ID
- `AUTHENTIK_CLIENT_SECRET`：Confidential Provider 的 Client Secret
- `AUTHENTIK_REDIRECT_URI`：完整回调地址，必须以 `/auth/oidc/callback` 结尾并与外部 OIDC 提供商配置一致
- `AUTHENTIK_SCOPES`：可选，默认 `openid profile email`
- `AUTHENTIK_TOKEN_AUTH_METHOD`：可选，`client_secret_basic` 或 `client_secret_post`；默认按 discovery 自动选择
- `AUTHENTIK_SESSION_TTL_SECONDS`：可选，远程管理会话最长有效期，默认 28800 秒，范围 300 到 604800
- `AUTHENTIK_COOKIE_SECURE`：可选；默认根据回调 URL 是否为 HTTPS 自动决定，生产环境不要关闭
- `AUTHENTIK_POST_LOGOUT_REDIRECT_URI`：可选，外部 OIDC 提供商登出后的返回地址
- `TRUSTED_PROXY_ADDRESSES`：可选，允许提供 `X-Forwarded-For` 的反向代理精确 IP 列表

如果需要让其它设备访问，可以用 `HOST=0.0.0.0` 启动。远程管理访问必须完整配置外部 OIDC 提供商；模型接口仍需使用本地 API Key，并建议同时使用 HTTPS、防火墙和网络访问控制。

## 注意事项

- `data/config.json` 含有上游 API Key、本地 API Key 和旧版兼容字段，请不要提交或分享；OIDC Client Secret 不会写入该文件。
- `data/metrics.json` / `data/metrics-log.jsonl` 只包含脱敏请求元数据、Token 数字与内容摘要（最后一条用户消息的截断文本，用于日志搜索），不包含完整请求正文、请求头、Key 或上游完整地址；仍建议不要分享运行数据目录。
- 已认证的管理后台会显示完整本地调用 Key；上游 API Key 仍只显示掩码。请避免向不受信任的用户授予外部 OIDC 提供商的管理后台访问权限。
- 第一版按最常见的 OpenAI Chat Completions 与 Anthropic Messages 协议实现，复杂的供应商私有字段、图片 URL 的特殊格式、部分高级工具参数可能需要后续适配。
- 当前余额功能是手工按需查询，不提供定时余额监控或告警；请求用量统计也不等同于上游账单。多用户权限可在后续继续扩展。

## 许可证

Sakura-AI-Gateway 采用 [Sakura-License](LICENSE)：源码可用，受覆盖衍生作品须共享并保留署名，特定商业利用需书面授权；它不是 OSI 批准的开源许可证。采用声明与商业授权联系方式见 [LICENSING.md](LICENSING.md)。

- `v2.4.0` 及之前的历史发布版本仍按 `LGPL-2.1` 授权，已合法取得的权利不受影响。
- `wiki/assets/marked.min.js` 为第三方 MIT 作品，保留其原许可，不属于本许可覆盖范围。
