# Sakura-AI-Gateway · Wiki

升级已有部署请先阅读[名称与数据迁移](migration.md)。

> 一个运行在本机的轻量模型聚合网关。零 npm 依赖，只使用 Node.js 内置 HTTP 服务和 `fetch`，
> 把本地客户端的 OpenAI / Anthropic / Responses 请求转发到多个可配置的上游站点，
> 并提供后台管理、模型选择、熔断、限流、指标与请求日志。

- **版本**：1.1.0（`package.json`）
- **运行要求**：Node.js ≥ 18
- **默认监听**：`127.0.0.1:8787`
- **数据目录**：`data/`（可用环境变量 `SAKURA_AI_GATEWAY_DATA_DIR` 覆盖）
- **许可证**：Sakura-License（正文见仓库根 `LICENSE`，采用声明见 `LICENSING.md`；历史版本为 `LGPL-2.1`）

---

## 快速上手

```powershell
cd Sakura-AI-Gateway
node src/server.js
# 或 npm.cmd start
```

启动后终端会打印默认本地 API Key（`sk-local_...`）。浏览器打开 <http://127.0.0.1:8787/>，
本机回环访问自动进入后台，无需管理凭据。本地客户端调用时把 Base URL 设为
`http://127.0.0.1:8787/v1`，使用后台创建的本地 Key 即可。

> 管理认证与模型调用认证互相独立：
> - 管理后台与 `/api/admin/*`：本机回环免认证；远程访问必须通过 Authentik OIDC。
> - `/v1/*` 模型接口：无论本机还是远程，都必须使用后台创建的本地 API Key。

---

## 功能概览

| 领域 | 能力 |
| --- | --- |
| 协议 | OpenAI Chat Completions、Anthropic Messages、OpenAI Responses，三者请求/响应/SSE 流式互转 |
| 上游管理 | 增删改、连接测试、余额查询（NewAPI / Sub2API）、`/v1/models` 拉取与回填、客户端标识预设 |
| 路由 | 精确匹配 → `*` 兜底 → 上游模型列表匹配；故障转移 / 轮询 / 加权轮询 / 随机四种策略；备用上游 |
| 模型选择 | 同名模型跨站合并、按前缀分组、本地别名、默认思考强度、模型级接口协议（Chat/Responses）；自动轮询池 / 固定站两种模式；可对上游未声明的模型主动探测思考强度档位 |
| 可靠性 | 内存熔断（阈值 + 冷却 + 半开探测）、全局并发限制、每 Key 每分钟限流、`x-request-id` 透传 |
| 指标日志 | 聚合计数存 `metrics.json`；请求日志追加写入 `metrics-log.jsonl`，可分页查询，上限可调 |
| 安全 | 回环免认证 + Authentik OIDC（Authorization Code + PKCE + JWKS + HttpOnly 会话）、本地 API Key 管理 |

---

## Wiki 目录

| 页面 | 内容 |
| --- | --- |
| [架构与模块](architecture.md) | 目录结构、各模块职责、请求生命周期、数据流 |
| [接口参考](api.md) | 模型调用接口、管理接口、认证/健康接口的完整清单 |
| [模型路由与轮询](routing.md) | 路由解析优先级、四种分流策略、熔断切换、模型选择器与轮询池（含 `upstreamIds` 子集） |
| [指标与请求日志](metrics.md) | 聚合计数与 JSONL 日志的存储设计、分页接口、压实与迁移、日志上限配置 |
| [认证与安全](security.md) | 双轨认证、Authentik OIDC 流程、反向代理与来源判断、数据文件安全 |
| [部署与配置](deployment.md) | 环境变量清单、启动方式、反向代理、可靠性设置 |
| [开发与测试](development.md) | 测试运行方式、测试覆盖范围、代码约定、已知边界与改进建议 |

---

## 最近变更（三项增强）

1. **同名模型可勾选参与轮询的上游子集**：模型选择器在「自动选择」模式下新增「轮询站点」勾选框，
   只让勾选的上游参与轮询；勾选数 < 2 时自动回退为全部站点（该保护目前仅在前端实现）。
2. **请求日志改为可分页的追加式滚动日志**：请求明细从 `metrics.json` 内联数组迁移到
   `metrics-log.jsonl`（append-only，超上限 2 倍时压实回上限）；新增
   `GET /api/admin/metrics/logs?limit=&offset=` 分页接口；旧版内联日志首次启动自动迁移。
3. **请求日志记录上游返回的结构化错误**：失败时每条日志带 `upstreamError`
   （HTTP `status` 与上游提供的 `code` / `type` / `param` / `message`），并且
   `attempts[].error` 记下**每一次尝试**分别被哪个上游以什么理由拒绝；
   后台「请求日志」直接显示上游 `code`，悬停可看完整明细。

详见 [指标与请求日志](metrics.md) 与 [模型路由与轮询](routing.md)。
