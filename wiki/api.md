# 接口参考

## 鉴权总览

| 接口范围 | 鉴权方式 |
| --- | --- |
| `/v1/*`（模型调用） | 后台创建的本地 API Key，`Authorization: Bearer <key>` 或 `x-api-key: <key>` |
| `/api/admin/*`（管理） | 本机回环访问免认证；远程必须登录（Authentik OIDC 会话 Cookie 或本地账号密码会话 Cookie） |
| `/health` | 无鉴权 |
| `/auth/*` | 无鉴权（登录/登出流程本身） |

所有模型调用响应都携带 `x-request-id`，JSON 响应体还会在首层携带 `request_id`
（客户端提供合法值时沿用，否则自动生成），
该 ID 会透传给上游，并写入请求日志。

JSON 和 SSE 错误消息统一为：

```text
[自定义前缀] [request_id=req_xxx] [code=错误码] 原始报错内容
```

自定义前缀通过 `PUT /api/admin/settings` 的 `errorPrefix` 设置，留空只省略前缀。
错误码优先取上游 `error.code`（Responses 流内错误也支持顶层 `code` 和
`response.error.code`），缺失时取 HTTP 错误状态码；流内错误以 `502` 兜底，
不以错误类别 `type` 或握手状态 `200` 代替。结构化 `code`、`type` 等字段及 HTTP
状态保持不变；错误消息中的请求 ID 与 `x-request-id`、顶层 `request_id` 一致，
与 Responses 的 `response.id`、工具的 `call_id` 无关。正常响应和正常 SSE 帧不加这些信息。

---

## 模型调用接口

### `POST /v1/chat/completions`（OpenAI Chat Completions）

转发到 OpenAI 兼容上游的 `/v1/chat/completions`，或经协议转换转发到 Anthropic 上游的 `/v1/messages`。
支持 `stream: true` 的 SSE 流式响应。
自动或 Chat 模式下，即使同时包含 function tools 与 `reasoning_effort`，仍使用上游 Chat 接口。
只有显式选择 `native`（Responses）模式才改用 `/v1/responses`，响应再转换回 Chat Completions（含工具调用与 SSE 增量）。

### `POST /v1/messages`（Anthropic Messages）

转发到 Anthropic 上游 `/v1/messages`，或经转换转发到 OpenAI 兼容上游。

### `POST /v1/responses`（OpenAI Responses API）

OpenAI 上游默认优先原生转发到上游 `/v1/responses`，保留 Responses API 的工具、Agent 状态和事件。
上游设置为“自动”时，仅对不含原生 Agent 能力的普通请求在上游返回 404/405/501 后回退到
Chat Completions；包含 `computer`、shell、apply_patch、`previous_response_id` 或其它原生字段的
请求不会有损回退。Anthropic 上游和显式 Chat 模式只能使用兼容转换。
携带 function tools 且 `reasoning_effort` 不为 `none` 的请求同样强制使用原生 `/v1/responses`；
若上游原生端点返回 404/405/501，则返回 `unsupported_agent_capability`，不会改发 `/v1/chat/completions`。
原生模式透明保留包括 `input`、`instructions`、`tools`、`tool_choice`、`previous_response_id`、
`include`、`reasoning` 和供应商扩展字段在内的请求字段；非流式响应与 SSE 事件同样原样转发。

### `GET /v1/models`

- 选择器模式关闭时：列出所有启用上游模型列表中的模型 + 手工路由。
- 选择器模式开启（`modelSelectionMode === true`）时：只列出勾选的本地模型与手工路由，
  不再展示未勾选的上游原始模型。

### 思考强度参数

客户端显式提供 `reasoning_effort`（OpenAI）或 `thinking`（Anthropic）时优先使用客户端值；
否则按模型选择/路由配置的 `thinkingLevel` 转换：

| 强度 | OpenAI 兼容上游 | Anthropic 上游 |
| --- | --- | --- |
| low | `reasoning_effort: low` | `thinking: { type: "enabled", budget_tokens: 2048 }` |
| medium | `reasoning_effort: medium` | `budget_tokens: 4096` |
| high | `reasoning_effort: high` | `budget_tokens: 8192` |
| none / minimal / xhigh | 按声明的原档位发送；`none` 不等于剥离参数 | 预算模式不提供映射，返回 `unsupported_thinking_level`（400） |
| client | 不主动添加，遵循客户端显式设置 | 不主动添加，遵循客户端显式设置 |
| auto / off | 不主动添加 | 不主动添加（上游声明不支持思考时也不添加） |

> 参数形态与目标端点自动匹配：发往 `/v1/responses` 的请求一律使用 `reasoning: { effort }`，
> 发往 `/v1/chat/completions` 的请求一律使用 `reasoning_effort`。客户端传入的另一种形态会被
> 网关转换，避免上游以「调用的接口类型和传入的参数不匹配」拒绝请求。

---

## 管理接口（`/api/admin/*`）

统一前缀，均需管理鉴权，响应头带 `Cache-Control: no-store`。

### 配置与模型目录

#### 单模型能力刷新与模态转译

`POST /api/admin/model-catalog/capabilities` 请求体：

```json
{ "upstreamId": "up_example", "modelId": "example-model", "probeThinking": true, "force": false }
```

刷新该上游 `/v1/models` 的声明；`probeThinking: true` 时只对指定模型补充已有的思考探测（会消耗额度），`force` 可强制重新探测。返回 `{ model, syncError, probe, catalog }`；同步失败保留已有能力，并通过 `syncError` 报告。模态不做主动付费探测。

目录新增 `inputModalities` / `outputModalities`（完整声明数组或 `null`）、`inputModalitySupport`（部分布尔声明）、`inputModalitySource` / `outputModalitySource` / `modalitySource`（`metadata` / `unknown`）。`null` 表示未知，空数组表示声明无对应模态。新声明优先，字段缺失时保留已有声明。每个上游独立记录。

模型选择与路由的创建/更新可传 `modalityTranslator: "本地模型别名"`；`""` 清除，省略保留。仅目标明确不支持的输入才会转成文本；未知或已支持则不转译。转译目标必须存在、启用、明确支持该输入，且调用 Key 对两个模型都获授权。不递归、不自动挑选未配置的模型。文件 ID 不能跨上游使用。

错误码：`unsupported_input_modality`（400，无转译配置）、`unsupported_modality_conversion`（400，协议转换会丢附件）、`unsupported_output_modality`（400，目标不支持输出模态）、`modality_translation_limit`（400，超过 16 个附件）、`modality_translation_failed`（400，配置或能力问题；502，转译失败/空结果/截断/超时）、`model_not_allowed`（403，无转译模型权限）。转译在目标响应开始之前执行，目标 `stream: true` 不改变转译调用的非流式方式。费用、隐私及支持边界见 README「输入模态与转译」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/config` | 返回脱敏配置（上游 apiKey 掩码，本地 Key 完整） |
| GET | `/api/admin/model-catalog` | 模型目录（按上游分组 + 对应选择） |
| POST | `/api/admin/model-catalog/sync` | 拉取全部启用上游的 `/v1/models` |
| POST | `/api/admin/model-catalog/capabilities` | 刷新模态声明，可选仅探测指定模型的思考档位，见上文 |
| POST | `/api/admin/model-catalog/thinking-probe` | 拉取思考强度：对元数据未表态的模型发极小探测请求，body 可传 `{ force: true }` 强制重探 |
| POST | `/api/admin/model-catalog/preview` | 保存前预览某上游的模型列表 |
| GET | `/api/admin/config/export` | 导出完整配置备份（`exportVersion: 1`） |
| POST | `/api/admin/config/import` | 导入备份；`preserveCredentials` 控制是否保留现有凭据 |

### 上游

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/upstreams` | 添加上游（返回 `201`，apiKey 掩码） |
| PUT | `/api/admin/upstreams/:id` | 更新上游；apiKey 留空时复用已保存 Key。`enabled:false` 停用后，模型目录不再展示该上游的模型（重新启用后自动恢复，已保存的模型选择不删除） |
| DELETE | `/api/admin/upstreams/:id` | 删除上游（同时清理其路由、本地模型选择、健康与余额缓存） |
| POST | `/api/admin/upstreams/:id/test` | 连接测试 |
| POST | `/api/admin/upstreams/:id/sync-models` | 同步该上游模型列表 |
| POST | `/api/admin/upstreams/:id/thinking-probe` | 只探测该上游的思考强度档位（返回结果 + 最新模型目录） |
| POST | `/api/admin/upstreams/:id/balance` | 查询单个上游余额 |
| POST | `/api/admin/upstreams/:id/reset-health` | 重置熔断/健康状态 |

### 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/routes` | 添加路由 |
| PUT | `/api/admin/routes/:id` | 更新路由 |
| DELETE | `/api/admin/routes/:id` | 删除路由 |

路由字段：`localModel`、`upstreamId`、`upstreamModel`、`fallbackUpstreamIds`、
`strategy`（`failover`/`round_robin`/`weighted`/`random`）、`upstreamWeights`、
`thinkingLevel`、`enabled`。

### 管理认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/admin-auth` | 当前远程认证方式与管理员账号列表（不含密码哈希） |
| PUT | `/api/admin/admin-auth/remote-mode` | 切换远程认证方式，body 为 `{ remoteMode: "oidc" \| "password" }` |
| POST | `/api/admin/admin-auth/users` | 新建管理员账号，body 为 `{ username, password }` |
| PUT | `/api/admin/admin-auth/users/:id` | 编辑账号，body 为 `{ username?, password?, enabled? }`，密码留空不修改 |
| DELETE | `/api/admin/admin-auth/users/:id` | 删除账号；本地账号模式至少保留一个启用账号 |

- 切换到 `password` 前必须存在启用账号；切换到 `oidc` 前必须完成 Authentik 环境变量配置
- 用户名 3 到 32 个字符（`A-Za-z0-9._@+-`），密码至少 8 个字符且不含空白
- 密码以 `scrypt$N$r$p$salt$hash` 格式哈希存储，接口永不返回哈希

### 本地 Key

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/local-keys` | 新建 Key（密钥自动生成，可配置模型权限） |
| PUT | `/api/admin/local-keys/:id` | 编辑名称 / 启用停用 / 分组与模型权限 |
| DELETE | `/api/admin/local-keys/:id` | 删除（系统至少保留一个 Key，最后一个不允许删除） |

新建和更新均支持：

```json
{
  "name": "桌面客户端",
  "modelAccessMode": "custom",
  "allowedGroups": ["gpt", "claude"],
  "allowedModels": ["gpt-4o", "my-claude"]
}
```

- `modelAccessMode`：`all`（默认、旧 Key 兼容）或 `custom`。非法模式/权限数组返回 400，更新不生效。
- `allowedGroups`：允许的目标模型前缀分组，与模型目录分组规则一致；例如 `my-claude → claude-sonnet` 属于 `claude` 组。
- `allowedModels`：独立授权的本地模型名。模型和分组**必须同时勾选**；授权别名不隐含授权上游原名或其他别名。大小写不敏感，显示保留首个拼写。
- 自定义 Key 只能访问已发布模型（即不限制 Key 所见的模型列表）。选择器模式开启后，未发布的上游原名不能绕过本地选择。通配路由不会授权任意模型名。
- 组内全选仅保存当前模型列表，不自动授权未来新同步的模型。自定义权限为空时拒绝全部模型。
- GET `/v1/models` 按 Key 过滤；Chat / Messages / Responses（包括流式请求）在转发前校验，未授权返回 HTTP 403、`error.code: model_not_allowed`，不请求上游。
- PUT 未提供权限字段时保留原值，启停/重命名不重置权限；切回 `all` 可保留勾选，下次切回 `custom` 继续使用。
- 备份保存权限；导入时 `preserveCredentials: true` 保留当前 Key 及权限，`false` 恢复备份 Key 及权限，旧备份缺失权限字段默认 `all`。


### 模型选择器

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| PUT | `/api/admin/model-selections` | 保存勾选；body 为 `{ selections: [...] }` |

`selection` 字段：`upstreamModel`（上游模型 ID）、`localModel`（本地别名）、
`upstreamId`（主站）、`upstreamIds`（轮询池子集）、`upstreamMode`（`auto`/`fixed`）、
`thinkingLevel`、`responsesMode`（`auto`/`native`/`chat`，模型级接口协议，覆盖上游设置）、`enabled`。
模型 ID **忽略大小写**：重复校验、`modelSelections` 记录和托管路由都以归一后的模型名为键，
因此 `gpt-4o` 与 `GPT-4O` 视为同一个模型（详见 [模型路由与轮询](routing.md)）。
详见 [模型路由与轮询](routing.md)。

### 可靠性设置与状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PUT | `/api/admin/settings` | 读取 / 更新可靠性设置 |
| GET | `/api/admin/upstream-status` | 上游健康状态（含 `settings`） |
| GET | `/api/admin/upstream-balances` | 全部上游余额（内存缓存） |
| POST | `/api/admin/upstream-balances/query` | 触发批量查询全部余额（最多 4 路并发） |

### 指标与请求日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/metrics` | 聚合计数 + 一页日志；支持 `?limit=&offset=` |
| GET | `/api/admin/metrics/logs` | 纯日志分页接口，返回 `{items, limit, offset, total, hasMore, maxLogs}` |
| GET | `/api/admin/metrics/range?from=&to=` | 按时间范围（闭区间，ISO 时间）聚合统计，返回 `{from, to, matched, totals, byUpstream}` |
| GET | `/api/admin/metrics/export?scope=recent\|all` | 导出最近 100 条或当前保留的全部用量记录（JSON） |
| DELETE | `/api/admin/metrics` | 清空聚合计数与 JSONL 日志 |

`limit` 默认 100、最大 500；`offset` 默认 0。详见 [指标与请求日志](metrics.md)。

---

### 第三方接入授权

供外部软件（如桌面客户端、IDE 插件）把本网关添加为其上游，无需进入后台手动复制 Key：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/integration/verify` | 外部项目填网关地址 + 本地 Key：校验权限、登记接入、拉取模型配置 |
| GET | `/api/integration/config` | 已接入后刷新配置：可用接入令牌或本地 API Key 认证 |
| POST | `/api/integration/revoke` | 凭令牌自助注销接入 |
| GET | `/api/integration/status` | 接入方凭令牌查看自己的授权状态（只含哈希，无明文） |

接入流程：外部项目把用户填写的地址作为根（如 `https://gateway.example.com`），调用
`POST {根地址}/api/integration/verify`，body 为 `{ apiKey, label? }`。`apiKey` 必须是网关本地已启用且
有权访问至少一个模型的 Key。响应里的 `authorization.token` **明文只出现一次**，落盘只存 SHA-256；
`models` 是按该 Key 权限过滤后的本地模型列表（含思考能力），`endpoints` 给出可用的相对路径。

```json
{
  "verified": true,
  "gateway": { "service": "sakura-ai-gateway", "version": "2.7.0" },
  "authorization": { "id": "int_...", "token": "sakura-int_...", "label": "我的插件", "status": "active" },
  "apiKey": { "id": "key_...", "name": "默认本地 Key", "modelAccessMode": "all", "allowedGroups": [], "allowedModels": [] },
  "endpoints": { "openai": { "models": "/v1/models", "chat": "/v1/chat/completions", "responses": "/v1/responses" }, "anthropic": { "messages": "/v1/messages" } },
  "models": [{ "id": "gpt-4o", "supportsThinking": false, "thinkingLevels": [] }],
  "modelsCount": 1,
  "nextSteps": ["保存令牌明文…", "用 Authorization: Bearer <API Key> 调用模型接口…", "GET /api/integration/config 刷新配置"]
}
```

- `config` 供接入方后续刷新模型列表：请求头携带 `Authorization: Bearer <接入令牌>` 或 `Authorization: Bearer <API Key>`；
  返回同样的 `models`/`apiKey`/`endpoints` 视图，不含令牌。已取消的授权返回 403。
- `revoke` 由接入方凭令牌自助调用，无需管理员；删除来源本地 Key 会级联取消其全部接入。
- 三个接口按来源 IP 限流（每分钟 60 次），超限返回 429。
- 登记随配置持久化（`config.integrations`），备份导出包含哈希记录；响应与导出均无明文。
- 管理员可在后台「本地调用 Key」标签页的「第三方接入授权」面板查看全部接入并手动取消，
  或调用 `GET /api/admin/integrations` / `POST /api/admin/integrations/:id/revoke`。

---

## 版本与升级接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/update-check?limit=6` | 检查最新版本并拉取最近版本的更新日志 |
| POST | `/api/admin/update` | 自动升级：下载带 SHA-256 校验的网关升级包并重启 |

- `update-check` 返回 `{ repository, checkedAt, currentVersion, latest, releases, upgradeAsset, updateAvailable }`。
  `latest` 为最新的非预发布版本；`releases` 为最近的稳定版列表（默认 6 条，`limit` 最大 20），
  每条含 `version`、`name`、`body`（Markdown 更新日志）、`publishedAt`、`assets`、`isCurrent`（是否当前版本）。
- 自动升级仅信任 `github.com` / `*.githubusercontent.com` 的 https 下载地址，且要求升级包带
  SHA-256 校验（资产名形如 `Sakura-AI-Gateway-v<版本>.tar.gz`）；升级时 `data/` 配置保留，服务短暂重启。
- 前端「版本与升级」面板提供「检查更新」与「更新日志」按钮，更新日志按 Markdown 渲染，
  最近 10 分钟内的检查结果会直接复用，避免重复请求 GitHub。

---

## 认证与健康接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（公开）：`{status:'ok', service:'sakura-ai-gateway', version, time}`；外部项目可用它确认地址是否指向本网关 |
| GET | `/auth/status` | 当前管理会话状态：`{authenticated, mode, configured, remoteMode, oidcConfigured, passwordConfigured, user}` |
| GET | `/auth/login` | 登录页；按 `remoteMode` 显示 Authentik 登录或账号密码表单 |
| POST | `/auth/password/login` | 本地账号密码登录，body 为 `{ username, password }`；成功返回会话 Cookie |
| GET | `/auth/login` | 网关本地登录页；不依赖 Authentik 在线，支持展示认证连接错误和重试 |
| GET | `/auth/oidc/login` | 发起 OIDC 登录（重定向 Authentik） |
| GET | `/auth/oidc/callback` | OIDC 回调（校验 code/state/nonce/PKCE/签名后建会话） |
| GET / POST | `/auth/logout` | 退出登录（同时请求 Authentik end_session_endpoint） |

---

## 错误与限流

- 模型接口校验失败 / Key 无效：`401`。
- 限流拒绝：`429` + `Retry-After` + `x-request-id`（不消耗并发槽 / 每分钟配额）。
- 上游不可用：按候选顺序切换；全部失败返回上游错误（含 `x-request-id`）。
- 管理接口未知路径：`404 { error: { message: '管理接口不存在' } }`。
