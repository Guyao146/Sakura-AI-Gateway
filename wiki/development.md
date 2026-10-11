# 开发与测试

## 模态能力与转译测试

`src/modalities.js` 负责能力元数据归一化、三种协议的附件遍历、转译配置检查与有损转换保护；运行 `node test/modalities.test.js` 验证纯函数。`node test/modalities.integration.test.js` 使用临时数据目录和本地模拟上游，覆盖能力刷新、单模型思考探测、按模型转译、权限、失败、流式、重复附件复用及配置重启/导入；两者均已注册到 `npm test`。不要使用真实上游验证主动探测，以免消耗额度或泄露附件。

可选真实浏览器冒烟测试：安装 Chrome，并使用 Node 22+（内置 WebSocket）运行：

```powershell
$env:GATEWAY_BROWSER_TEST = '1'
try { node test/modalities.integration.test.js }
finally { Remove-Item Env:GATEWAY_BROWSER_TEST }
```

可通过 `CHROME_PATH` 指定 Chrome 可执行文件路径。测试使用独立临时用户配置，检查模态展示、模型行转译选择保存、单模型能力刷新、路由新增/编辑，以及浏览器脚本异常；不安装额外依赖。

## 运行测试

无第三方依赖，全部测试是纯 Node 脚本（`node:assert/strict`）。运行全部测试：

```powershell
cd Sakura-AI-Gateway
npm.cmd test
# 等价于依次执行 package.json 中注册的测试脚本
```

测试清单（`package.json` 的 `scripts.test`）：

| 文件 | 类型 | 覆盖 |
| --- | --- | --- |
| `test/branding.test.js` | 单元 | 项目名、构建产物、仓库/镜像与旧名称残留检查 |
| `test/brand-migration.test.js` | 单元/进程 | 新旧环境变量优先级、数据/指标目录与桌面数据迁移 |
| `test/protocol.test.js` | 单元 | OpenAI ↔ Anthropic、Responses 转换、endpoint 拼接 |
| `test/routing.test.js` | 单元 | 四种分流策略的排序与游标、权重分布 |
| `test/model-groups.test.js` | 单元 | 模型目录分组、勾选合并、轮询池勾选（`pool-provider`）、日志分页接口存在性 |
| `test/key-access.test.js` | 单元 | 前后端共用的权限归一化、分组、发布列表、别名独立授权与通配路由 |
| `test/key-access.integration.test.js` | 集成 | Key 增改/启停、三个协议 403（含 stream）、禁止访问不转发、权限过滤、导入/重启持久化 |
| `test/balance.test.js` | 单元 | NewAPI/Sub2API 余额解析、余额路径安全校验 |
| `test/client-identity.test.js` | 单元 | 客户端标识预设、自定义 UA 校验 |
| `test/admin-auth.test.js` | 单元 | 回环识别、转发头伪造防护、可信代理解析 |
| `test/auth.integration.test.js` | 集成 | 模拟 OIDC 服务：登录流程、PKCE/state/nonce、会话、登出 |
| `test/gateway.integration.test.js` | 集成 | 转发/备用/熔断/限流/并发/`x-request-id`/余额查询 |
| `test/stream.integration.test.js` | 集成 | 流式响应转换与 SSE 转发 |
| `test/model-selection.integration.test.js` | 集成 | 模型选择保存、`upstreamIds` 轮询池、固定站、旧备份合并迁移 |
| `test/model-case.integration.test.js` | 集成 | 模型名/中转站大小写合并、按各站拼写转发、重复选择拒绝、备份导入合并 |
| `test/metrics-range.integration.test.js` | 集成 | `/api/admin/metrics/range` 参数校验、闭区间命中、范围与全量统计互不影响 |
| `test/integration-auth.test.js` | 集成 | 接入授权 verify/revoke/status、令牌哈希、Key 删除级联取消、备份导入保留 |
| `test/release-notes.test.js` | 单元 | 更新日志 Markdown 渲染：标题/列表/引用/代码块、链接协议白名单、注入转义 |

集成测试模式：

- 用 `fs.mkdtempSync(os.tmpdir())` 创建临时数据目录，
  以 `spawn(process.execPath, ['src/server.js'])` 启动真实网关进程。
- 用内存 HTTP mock 服务模拟上游（OpenAI/Anthropic 两站）。
- 随机端口（如 `19000+`、`21000+`）避免冲突；`waitForOutput` 等待启动标记
  （如「本地管理访问：无需认证」）。

## 新功能在测试中的落点

- **轮询池勾选（前端）**：`model-groups.test.js` 断言 `app.js` 存在
  `data-action="pool-provider"`，并验证 `upstreamMode: auto` 时 `upstreamIds` 合并正确。
- **日志分页（后端）**：`model-groups.test.js` 断言 `app.js` 引用
  `/api/admin/metrics/logs`；分页/压实/迁移另用独立临时脚本验证过。
- **`upstreamIds` 落库与路由合成**：`model-selection.integration.test.js` 覆盖
  auto 模式保存、轮询请求在两站间分配、切到 fixed 后单站、旧备份同名选择合并为候选池。
- **拉取思考强度（后端全链路）**：`thinking.integration.test.js` 用两个假上游覆盖
  元数据跳过、逐档试探、参数被整体拒绝时提前结束、429 不改写判断、探测不写指标/不进熔断、
  探测结论挺过重新同步、单站接口 404、非 JSON 请求体容错。
- **大小写合并（前后端）**：`model-groups.test.js` 断言 `mergeModelsById` 合并大小写不同、
  键归一化与 `app.js` 的 `uniqueModelLabels`；`model-case.integration.test.js` 用一个
  自身就返回 `gpt-4o`/`GPT-4O` 的假上游加第二个站点，覆盖同站合并落库、跨站合成一条选择、
  按各站拼写转发、重复选择被拒、备份导入换大小写仍对得上并合并重复项。

## 代码约定

- CommonJS：`require` / `module.exports`，无 ESM。
- 纯函数尽量独立成模块（`protocol.js`、`routing.js`、`balance.js` 等），便于单测。
- 配置文件写入一律 `.tmp` + `rename` 原子替换，`0o600`（Windows 下 chmod 失败被忽略）。
- 前端：`app.js` 使用 `#id` 选择器辅助函数与 `data-action` 事件委托；字符串渲染 +
  `escapeHtml` 防注入；无框架。
- 错误消息使用中文，便于后台直接展示。
- 集成测试只在临时目录写文件，不污染项目 `data/`。

## 已知边界与改进建议

1. **轮询池「至少两站」保护仅在前端**：直接调 `PUT /api/admin/model-selections`
   提交 <2 个 `upstreamIds` 后端不校验。建议在 `saveModelSelections` 增加子集校验：
   过滤不存在/已停用站，长度 <2 时回退为全部站点。
2. **~~JSONL 压实与迁移无专项单测~~（部分完成）**：`test/metrics.test.js` 已用注入的
   临时 `DATA_DIR` 覆盖 `recordRequest/getLogs/importUsageRecords` 与
   `upstreamError`/`attempts[].error` 的归一化；**JSONL 压实与旧版内联日志迁移仍未覆盖**，
   只靠临时脚本验证，建议补对 `appendLog` 触发压实、`loadLogs` 迁移路径的断言。
3. **~~`.gitignore` 未包含 `data/metrics-log.jsonl`~~**：已修复，运行时日志不会被提交。
4. **模型选择器与手工路由冲突**：同名冲突会在保存时报错，但前端反馈路径可再打磨。
5. **日志只保留成功/失败的摘要**：不含请求体/响应体，若需排查内容级问题需另加审计日志。
6. **多用户权限**：Authentik 只做「能进后台即可管理」的粗粒度控制；细分权限待扩展。
7. **思考能力识别依赖字段名**：私有站点的能力字段可能需要持续适配；元数据没给档位时可用
   管理台的「拉取思考强度」主动探测，但探测仍依赖上游错误信息的可读性。

## 变更记录（本次迭代）

- 轮询池子集：`public/app.js` 的 `renderModelRow` / `syncRenderedModelDraft`、
  `styles.css` 的 `.model-pool*`、`index.html` 文案；后端 `saveModelSelections` 原已支持
  `upstreamIds`，未改动。
- 滚动日志：`src/metrics.js`（append-only + 压实 + `getLogs`）、`src/server.js`
  （`GET /api/admin/metrics/logs` 与 metrics 分页参数）、`public/app.js`
  （`renderLogRow`/`updateLogSummary`/`loadMoreLogs`）、`public/index.html`
  （`requestLogSummary` + 加载更多按钮）、`public/styles.css`（`.log-more`）、
  `README.md` 两处说明、`test/model-groups.test.js` 两条断言。
- 请求日志记录上游返回的错误：`src/errors.js` 新增 `upstreamErrorDetails`
  （`errorCode` 拆出 `upstreamCode`/`httpStatusCode` 复用），`src/metrics.js` 的
  `recordRequest`/`cloneLog`/`normalizeImportedLog`/`normalizeAttempts` 收敛
  `upstreamError` 与 `attempts[].error`（字段截断），`src/server.js` 在上游失败、
  HTTP 200 内失败、流式失败、Responses 原生能力不支持四条路径采集，
  `public/app.js` 的 `renderLogRow` 显示上游 code（结果列标签 + 悬停明细 +
  每次尝试的 code），`wiki/metrics.md` 字段说明；测试为新增 `test/metrics.test.js`
  与 `test/errors.test.js`、`gateway.integration.test.js`、`stream.integration.test.js`
  的断言（`npm test` 已纳入 `test/metrics.test.js`）。
- 拉取思考强度：`src/server.js` 新增 `classifyThinkingProbe` / `thinkingProbePlan` /
  `probeThinkingLevel` / `probeModelThinking` / `probeUpstreamThinking` /
  `probeAllUpstreamThinking` 与 `POST /api/admin/model-catalog/thinking-probe`、
  `POST /api/admin/upstreams/:id/thinking-probe`；`modelCapabilityMetadata` 增加
  `metadataDeclared` 并把档位优先级改为「上游声明 > 探测 > 三档兜底」，同时摘掉探测写回的
  `supportsThinking`/`thinkingLevels` 以免被当成上游声明；`normalizeModelCatalog` 透传
  `thinkingSource`/`thinkingProbedAt`；`safeUpstreamBalanceMessage` 提出公共的
  `sanitizeUpstreamMessage` 复用脱敏；`public/app.js` 新增 `mergedThinkingCapability` /
  `thinkingMarkup` / `thinkingLevelOptions` / `probeAllThinking`，`public/index.html`
  加工具栏按钮与说明，`public/styles.css` 加 `.thinking-probe-tag`；
  测试为新增 `test/thinking.integration.test.js` 并纳入 `npm test`。
- 中转站与模型名大小写合并：`src/server.js` 新增 `modelIdKey`/`sameModelId`，
  `normalizeModelCatalog` 改为按大小写归一键合并（名称沿用当前名称、能力由后来者补齐），
  `catalogForUpstream` 兜底条目同规则，`mergeModelCatalog`/`syncUpstreamModels` 合并后
  同步重写 `upstream.models`，`modelEntryFor` 先精确后忽略大小写命中，
  `makeUpstreamRequest` 按站点真实拼写转发，`chooseRoute`、`publicModelCatalog` 的选择链接、
  `saveModelSelections` 的重复校验与 `previousByModel`、`modelSelectionKey`、
  备份导入的 `selectionsByModel` 全部改为大小写归一（重复选择报 400）；
  前端 `public/model-groups.js` 的 `mergeModelsById`/`unifiedModelSelectionKey`、
  `public/app.js` 的 `reconcileModelSelectionDraft` 与 `uniqueModelLabels` 同步调整，
  `public/index.html` 补充说明；测试新增 `test/model-case.integration.test.js`
  并在 `test/model-groups.test.js` 加单元断言。
