# 架构与模块

## 目录结构

```
Sakura-AI-Gateway/
├── src/
│   ├── server.js            # 入口与主逻辑（HTTP 服务、鉴权、路由、转发、管理接口）
│   ├── config.js            # 配置读写（原子写、密钥掩码、默认值）
│   ├── metrics.js           # 指标聚合 + JSONL 请求日志 + 分页
│   ├── admin-auth.js        # 回环识别 + Authentik OIDC + 本地账号密码认证
│   ├── protocol.js          # OpenAI / Anthropic / Responses 互转
│   ├── routing.js           # 分流策略（候选排序）
│   ├── balance.js           # 上游余额响应解析
│   └── client-identity.js   # 客户端标识（User-Agent 预设）
├── public/
│   ├── index.html           # 管理后台页面
│   ├── app.js               # 后台交互逻辑
│   ├── model-groups.js      # 模型目录分组/勾选合并辅助
│   └── styles.css
├── data/                    # 运行时数据（已被 .gitignore 忽略）
│   ├── config.json          # 配置（含密钥）
│   ├── metrics.json         # 聚合计数
│   └── metrics-log.jsonl    # 请求日志（append-only）
└── test/                    # 单元 + 集成测试（均为纯 Node 脚本）
```

## 模块职责

### `src/server.js`（约 1990 行，核心）
- 启动 HTTP 服务，默认监听 `127.0.0.1:8787`，支持 `HOST`/`PORT` 环境变量。
- 模型调用接口：`POST /v1/chat/completions`、`POST /v1/messages`、`POST /v1/responses`、`GET /v1/models`。
- 管理接口：`/api/admin/*`（见 [接口参考](api.md)）。
- 上游健康跟踪与内存熔断、全局并发与每 Key 限流、`x-request-id` 生成与透传。
- 模型目录同步、余额查询、配置导入导出、模型选择器（把 `modelSelections` 合成托管路由）。

### `src/config.js`
- 首次启动生成默认配置并写入 `data/config.json`（原子写：先写 `.tmp` 再 `rename`，`0600`）。
- `publicConfig` 对上游 `apiKey` 做掩码后再下发前端；本地 Key 完整返回。
- `makeId`（6 字节随机 hex）与 `makeSecret`（24 字节 base64url）用于生成 ID 和密钥。
- 损坏的配置文件直接抛出启动错误（`配置文件损坏，无法读取...`）。

### `src/metrics.js`
- 聚合计数与请求日志分离存储：
  - `metrics.json`：总量 + 按上游统计的计数器（每次请求重写）。
  - `metrics-log.jsonl`：逐条请求明细，append-only 追加，定期压实。
- 提供 `getMetrics({limit, offset})`、`getLogs({limit, offset})`、`clearMetrics()`。
- 详见 [指标与请求日志](metrics.md)。

### `src/admin-auth.js` 与 `src/admin-users.js`

`admin-users.js` 是纯函数模块：scrypt 密码哈希（`scrypt$N$r$p$salt$hash`）、用户名/密码校验、
`userFromBody`（新建/编辑账号，编辑时密码留空表示保留旧哈希）。

`admin-auth.js` 负责传输层：
- 来源识别与回环判定（`requestSource`、`isLoopbackAddress`）。
- Authentik OIDC：discovery 缓存、Authorization Code + PKCE + state/nonce、JWKS 签名校验、HttpOnly 会话。
- 本地账号密码：`loginWithPassword` 校验凭据后创建与 OIDC 相同的会话 Cookie；
  `remoteMode()`/`remoteConfigured()` 决定远程访问的认证方式和错误提示。
- 来源失败锁定：5 分钟内同一来源失败 5 次锁定 60 秒，返回 429。

两种远程认证共用会话表与同源校验，详见 [认证与安全](security.md)。

### `src/protocol.js`
- `openAIToAnthropic` / `anthropicToOpenAI` / `openAIResponseToAnthropic` / `anthropicResponseToOpenAI`。
- `responseInputToOpenAI` / `openAIResponseToResponses`：普通 Responses 请求与 Chat Completions 的兼容转换；
  原生 Responses 请求由 `server.js` 直接透传，避免丢失 Agent 工具和扩展事件。
- 统一流式响应的响应 ID，支持文本增量、结束事件与 usage 透传。

### `src/routing.js`
- 四种候选排序策略：`failover`（顺序）、`round_robin`（游标轮转）、`weighted`（平滑加权轮询）、`random`。
- 状态存内存（`roundRobinCursors` / `weightedStates`），`resetRoutingState()` 可重置。
- 候选排序后仍会在选中站失败时逐个尝试其余候选。

### `src/balance.js`
- 解析 NewAPI Token Usage（`quota` 型）、常见额度字段、Sub2API 平台额度（`platform-quotas` 型）。
- `normalizeBalanceEndpoint` 只接受同源相对路径，拒绝查询参数、`..`、反斜杠、控制字符。

### `src/client-identity.js`
- 预设：`default`、`claude_code`（`User-Agent: claude-code`）、`codex_cli`（含 `originator`）、
  `cherry_studio`、`custom`。自定义 UA 最长 300 字符并拒绝 CR/LF/Tab 等控制字符。

## 请求生命周期

```
本地客户端 ── /v1/chat/completions 等 ──▶ requestHandler
  │ 校验本地 API Key（Authorization / x-api-key）
  │ 并发槽 + 每 Key 限流检查（429）
  ├─▶ chooseRoute(model)：精确路由 → '*' 兜底 → 上游模型列表匹配 → 单上游自动转发
  │      route 候选 = [upstreamId, ...fallbackUpstreamIds]，过滤禁用/熔断站
  │      orderCandidates(route, candidates) 按策略排序
  ├─▶ 依次尝试候选：连接失败 / 超时 / 408/425/429 / 5xx 时切下一个
  │      4xx 参数或鉴权错误不换站（避免掩盖配置问题）
  ├─▶ 协议转换：本地协议 ≠ 上游协议时经 protocol.js 转换
  ├─▶ 流式：SSE 转发，切站只发生在建立上游响应之前
  └─▶ recordRequest(...)：更新聚合计数 + 追加 JSONL 日志
```

## 配置数据流

- `saveConfig` 每次写整份 `config.json`（配置量小，写放大可接受）。
- `saveModelSelections` 把前端提交的 `selections` 规范化后写入 `modelSelections`，
  并同步生成/更新 `managedBy: 'model-selector'` 的托管路由（见 [模型路由与轮询](routing.md)）。
- 指标写放大问题通过「聚合在 JSON 文件 + 明细走 JSONL」拆分解决（见 [指标与请求日志](metrics.md)）。

## 关键设计取舍

- **零依赖**：全部使用 Node 内置模块（`http`、`fs`、`crypto`、`node:test` 不用，测试用 `assert` 脚本）。
- **回环免认证 + 远程 OIDC**：本机体验友好，远程访问安全可控。
- **熔断状态仅存内存**：重启即清零，避免把健康状态持久化带来的复杂性。
- **路由状态仅存内存**：轮询/加权游标重启后重新开始。
