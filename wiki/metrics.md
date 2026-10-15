# 指标与请求日志

## 存储设计：聚合与明细分离

每次模型请求都会记录明细并累加计数，但**计数和明细分开存放**，避免每请求重写大文档的写放大：

| 文件 | 内容 | 写入方式 |
| --- | --- | --- |
| `data/metrics.json` | 聚合计数（总量 + 按上游 + 按本地 Key ID 统计） | 每次请求整份原子重写 |
| `data/metrics-log.jsonl` | 逐条请求明细，一行一条 JSON | append-only 追加 |

### `metrics.json` 结构

```jsonc
{
  "version": 1,
  "totals": {
    "requests": 0, "successful": 0, "failed": 0, "failovers": 0,
    "promptTokens": 0, "completionTokens": 0, "totalTokens": 0
  },
  "byUpstream": {
    "站点名": { "requests": 0, "successful": 0, "failed": 0,
                "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 }
  },
  "byKey": {
    "key_<hex>": {
      "keyId": "key_<hex>", "keyName": "桌面应用",
      "requests": 0, "successful": 0, "failed": 0, "failovers": 0,
      "promptTokens": 0, "completionTokens": 0, "totalTokens": 0,
      "lastRequestAt": null
    }
  }
}
```

- `byUpstream` 按上游**名称**分组；每次 `recordRequest` 会为 `attempts` 中的每个上游各计一笔，
  token 只记给最终成功响应的那个站。
- 文件损坏时启动不崩溃（回退为空指标）。

## 按 Key 统计

后台「请求统计」提供分 Key 表格：请求数、成功/失败、成功率、故障转移、输入/输出/总 Token、最近调用时间，按请求数降序排列，每 5 秒刷新。表格与上方总量、按上游统计共用时间范围筛选。

- 按 **Key ID** 而非名称归并：同名不同 Key 分开计数，改名不拆分历史。表格优先显示当前配置的名称，`byKey[].keyName` 保存最近已记录请求中的名称。
- 已配置但未使用的 Key 在页面补零展示（无调用时成功率和最近调用显示 `-`）；停用和删除不会清除历史，页面会标注状态。统计接口只返回实际有累计记录的 Key。
- OAuth 调用归入授权的来源 Key；附件转译子请求也单独归入发起者 Key。**同一请求内的重试/切换只计一个请求和一份最终用量**，同上游重试不算故障转移。
- 延续现有总量口径：统计进入模型转发流程的请求及附件转译子请求；鉴权失败、模型权限拒绝、限流、请求体解析失败、模型列表查询与后台能力探测不计入。上游不报告 Token 时按零记录，不自行估算。
- `lastRequestAt` 为所统计请求的最新完成时间（缺少时回退开始时间），以 ISO 时间返回；无法恢复时间时为 `null`。成功率由 `successful / requests` 计算。
- 全量 `byKey` 与总计同存于 `metrics.json`，**重启和 JSONL 裁剪不会降低累计**；清空统计会同时清除。时间范围统计只覆盖当前保留明细，不是无限期历史查询。
- 字典中的空字符串键 `""` 表示**未归属 Key**，其 `keyId` 为 `null`、`keyName` 为空；用于无来源 Key 的日志，以及升级时无法恢复归属的旧累计。不会凭名称猜测归属。
- 统计与导出中只记录 Key ID/名称，不记录密钥内容或 OAuth 令牌；接口继续要求管理后台认证，不新增面向普通调用 Key 的查询权限。

### `metrics-log.jsonl` 单条日志字段

```jsonc
{
  "id": "req_<hex>",          // x-request-id，客户端提供的合法值会被沿用
  "startedAt": "ISO 时间",
  "finishedAt": "ISO 时间",
  "protocol": "openai | anthropic | responses",
  "keyId": "调用的本地 API Key ID",
  "keyName": "Key 名称",
  "contentDigest": "最后一条用户消息的截断文本",
  "upstream": "最终上游名",
  "upstreamModel": "上游模型名",
  "status": 200,              // 最终 HTTP 状态码
  "durationMs": 1234,
  "stream": false,
  "success": true,
  "failover": false,          // 尝试过多个不同上游
  "attempts": [{ "upstream": "...", "status": 503, "retry": 0, "error": { ... } }],  // 按尝试顺序，最多保留 12 条；retry > 0 表示同一上游的第 N 次原地重试
  "usage": { "promptTokens": 0, "completionTokens": 0, "totalTokens": 0 },
  "error": "错误信息（仅失败时）",
  "upstreamError": { "status": 503, "code": "...", "type": "...", "param": "...", "message": "..." }  // 仅失败且上游返回错误时
}
```

日志含元数据、token 数字与**内容摘要**，但**不含完整请求正文、请求头、API Key 或上游完整地址**。

- `keyId` / `keyName` 标识发起请求的本地 API Key（用于按 Key 筛选），日志与接口响应都不会返回 Key 本身。
- `contentDigest` 是客户端最后一条用户消息的截断文本（空白折叠，上限 500 字符），用于在请求日志里检索历史提问；
  它是从请求体提取的摘要，不是完整对话记录。

- `error` 是给客户端看的错误信息原文；`upstreamError` 记录上游**实际返回**的结构化错误，
  含 HTTP `status` 与上游提供的 `code` / `type` / `param` / `message`（缺失的字段不出现），
  例如 `{ "status": 400, "code": "upstream_request_rejected", "message": "..." }`。
  `code` 只取上游给出的值，不用 HTTP 状态码兜底——状态码单独记在 `status` 里。
- `attempts[].error` 记录**每一次尝试**被上游拒绝的原因，用于排查故障转移中各站点分别为什么失败；
  连接失败等没有上游响应的情况不记录该字段。

管理页面可将最近 100 条记录或当前日志上限内的全部记录导出为 JSON。导出内容包含
聚合 totals、byUpstream、byKey 和 records 明细；`records` 按时间正序排列，便于归档或分析。

## 请求日志搜索与筛选

管理页面「请求日志」提供组合筛选：

- **关键字**：匹配请求 ID、模型、上游模型、上游名、Key 名称、错误信息、内容摘要以及每次尝试的上游错误码，大小写不敏感。
- **本地 Key**：下拉框列出近期日志中出现过的 Key（从管理接口 `/api/admin/metrics/keys` 获取），只显示 Key 名称与请求次数。
- **时间段**：闭区间筛选，空值表示不限制。

搜索框输入后防抖 300ms 再请求；筛选结果与「加载更多」分页共用同一筛选条件。
对应后端接口为 `GET /api/admin/metrics/logs?keyword=&keyId=&from=&to=&offset=&limit=`，
返回 `{items, limit, offset, total, hasMore, maxLogs, filters}`，`filters` 回传规范化后的实际筛选条件。

## 日志上限与压实

- **默认保留 5000 条**，环境变量 `SAKURA_AI_GATEWAY_MAX_LOGS` 可调，**下限 100**。
- 追加使文件行数超过 `MAX_LOGS × 2` 时，触发一次**压实**：把内存中最新的 `MAX_LOGS` 条
  原子重写回 JSONL（`.tmp` + `rename`），避免文件无限增长。
- 内存中始终只缓存最新 `MAX_LOGS` 条（新在前）；加载时读取文件尾部并反向。

## 分页接口

### `GET /api/admin/metrics/logs?limit=&offset=`

返回：

```jsonc
{
  "items":   [ /* 本页日志，新在前 */ ],
  "limit":   100,     // 默认 100，最大 500
  "offset":  0,       // 默认 0
  "total":   5000,    // 当前可查日志总数
  "hasMore": false,
  "maxLogs": 5000     // 上限，供前端展示
}
```

### `GET /api/admin/metrics?limit=&offset=`

返回聚合计数 + `logs`（一页明细）+ `logPage` 元信息（同上的 `limit/offset/total/hasMore/maxLogs`）。

### 前端「加载更多」

- 首次渲染用 `GET /api/admin/metrics?limit=100`（或 `logs` 为空时）。
- 「加载更多」按钮以 **当前已渲染行数** 作为 `offset`、`limit=100` 请求
  `GET /api/admin/metrics/logs`，追加渲染并更新「已显示 X / Y」计数与 `hasMore`。
- 页面显示 `maxLogs` 用于提示「日志最多保留 5000 条」之类的说明。

### `DELETE /api/admin/metrics`

清空聚合计数、内存日志，并把 JSONL 重写为空文件（`clearMetrics`）。

### `GET /api/admin/metrics/range?from=&to=`

按时间范围统计明细日志，参数为 ISO 时间（含 `datetime-local` 本地时间转换后的值），闭区间：

- 返回 `{from, to, matched, totals, byUpstream, byKey}`；`matched` 为命中明细条数。
- 聚合口径与实时统计完全一致（同一 `aggregateInto`：totals、byUpstream、byKey、故障转移判定、
  token 归属最后尝试）。参数缺失、非法或开始晚于结束返回 400。
- 后台「按时间统计」使用该接口；范围模式下 5 秒自动刷新仍刷同一时间窗口，新请求会
  计入当前视图。重置后返回全量统计。

### 导出与导入

管理页面可以导出最近 100 条或当前日志上限内的全部用量记录。导出文件中的 `records`
按时间正序排列。`POST /api/admin/metrics/import` 接受该导出对象或 records 数组，以请求
`id` 去重；当前保留日志和同一文件内的重复记录不会重复计入。只将新增记录累加到已有
`totals`、`byUpstream`、`byKey`，不会因旧明细已裁剪而重置全量累计。支持导出中的 camelCase
Token 字段及上游风格的 snake_case 字段。

**导入边界：**去重范围是当前保留的日志，不维护无限期请求 ID 索引；重新导入已经被裁剪的
旧记录可能重复累计。导出的聚合快照用于查看/分析，导入仅处理 `records`，不会直接覆盖或
叠加快照（避免混入重复计数）。因此导出中的历史累计若已没有对应明细，清空后仅靠用量导入
无法完整恢复；完整迁移应一起备份数据目录中的聚合和日志文件。

## 旧数据迁移

旧版本把日志以内联数组 `logs`（新在前）存在 `metrics.json` 里。新版启动时：

1. 若 `metrics.json` 含 `logs` 数组，将其 **反转为时间正序** 后追加写入 JSONL
   （截断到 `MAX_LOGS` 条）。
2. 写完后 `saveMetrics()` 落盘，从 `metrics.json` 中移除内联 `logs`（以后不再有该字段）。

旧 `metrics.json` 缺少 `byKey` 时，首次启动从当前保留日志回填分 Key 统计，但保持原有
`totals` 和 `byUpstream` 不变；超出保留日志、无法确定来源的历史累计归入“未归属 Key”。
如果旧计数与明细冲突，保守地把原计数全部标为未归属，不生成负数或猜测分摊。
迁移结果原子保存，后续重启不会重复回填。

`test/key-metrics.test.js` 覆盖迁移、重启、压实、导入和范围聚合；完整 HTTP 与浏览器覆盖见
[开发与测试](development.md)。

## 相关配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `SAKURA_AI_GATEWAY_MAX_LOGS` | `5000` | JSONL 日志保留条数，最小 100 |
| `SAKURA_AI_GATEWAY_DATA_DIR` | 项目下 `data` | 数据目录（含 `metrics.json`、`metrics-log.jsonl`） |
