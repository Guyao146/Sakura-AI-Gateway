# 部署与配置

## 启动方式

需要 Node.js ≥ 18（服务使用内置 `fetch`）。

```powershell
cd Sakura-AI-Gateway
node src/server.js
# 或 npm.cmd start；开发热重载可用 npm.cmd dev（node --watch）
```

首次启动生成默认配置：随机 adminToken、默认本地 Key、空上游/路由，并监听
`127.0.0.1:8787`。

## Docker Compose 一键部署

服务器推荐使用项目自带的 Docker Compose 方案。正式发布时，镜像由 CI 推送到 GHCR，
使用对应已发布标签即可，无需在服务器构建。要求已安装 Docker Engine 和 Docker Compose Plugin。在任意空目录
新建 `docker-compose.yml`：

```yaml
services:
  gateway:
    image: ghcr.io/guyao146/sakura-ai-gateway:latest
    restart: unless-stopped
    init: true
    environment:
      HOST: 0.0.0.0
      PORT: 8787
      SAKURA_AI_GATEWAY_DATA_DIR: /app/data
    ports:
      - "8787:8787"
    volumes:
      - gateway-data:/app/data

volumes:
  gateway-data:
    name: ${SAKURA_AI_GATEWAY_VOLUME:-sakura-ai-gateway-data}
```

已有部署请先按[迁移说明](migration.md)设置 `SAKURA_AI_GATEWAY_VOLUME` 为原卷名。新部署直接拉取并启动：

```bash
docker compose pull
docker compose up -d
docker compose ps
```

仓库中的完整版 `docker-compose.yml` 支持 `.env` 中的 `GATEWAY_PORT`、镜像标签和
Authentik 参数。固定版本使用新镜像仓库中实际发布的 Release 标签；`latest` 跟随
最新正式 Release。网关配置和密钥保存在 Docker 命名卷（默认 `sakura-ai-gateway-data`），重新创建容器
不会丢失。常用运维命令：

```bash
docker compose ps
docker compose logs -f gateway
docker compose restart gateway
docker compose down
docker compose pull && docker compose up -d  # 更新镜像
docker run --rm -v "${SAKURA_AI_GATEWAY_VOLUME:-sakura-ai-gateway-data}:/data:ro" -v "$PWD":/backup alpine tar czf /backup/Sakura-AI-Gateway-data-backup.tgz -C /data .
```

公网部署不要直接把管理后台裸露在互联网上：应使用 HTTPS 反向代理，并配置完整的
Authentik OIDC（`AUTHENTIK_REDIRECT_URI` 必须是公网 HTTPS 地址加
`/auth/oidc/callback`）。如果 Nginx 与容器在同一台服务器，通常将
`TRUSTED_PROXY_ADDRESSES` 设置为实际反代 socket 的**精确 IP**（不支持 CIDR）；请以
网关日志中的反代来源为准配置。模型客户端使用：
`https://你的域名/v1`，并携带后台生成的本地 API Key。

首次访问后台后立即保存本地 API Key，并将 `.env`、`data/config.json` 和备份文件限制
为管理员可读。Docker 方案默认以非 root 用户运行，容器内网关固定监听 `8787`，
宿主机端口由 `GATEWAY_PORT` 控制。

## 环境变量清单

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址；`0.0.0.0` 暴露到局域网 |
| `PORT` | `8787` | 监听端口（1–65535） |
| `SAKURA_AI_GATEWAY_DATA_DIR` | 项目下 `data` | 配置/指标数据目录 |
| `SAKURA_AI_GATEWAY_MAX_LOGS` | `5000` | JSONL 请求日志保留条数，最小 100 |
| `SAKURA_AI_GATEWAY_FORCE_HOST` | — | 强制覆盖配置文件中的监听地址（桌面客户端使用） |
| `SAKURA_AI_GATEWAY_FORCE_PORT` | — | 强制覆盖配置文件中的端口（桌面客户端使用） |
| `SAKURA_AI_GATEWAY_FORCE_SETTINGS` | `false` | 以 `HOST` / `PORT` 覆盖配置文件 |
| `SAKURA_AI_GATEWAY_VOLUME` | `sakura-ai-gateway-data` | Compose 数据卷实际名称；升级时指定原卷 |
| `AUTHENTIK_ISSUER_URL` | — | Authentik Application 的 OIDC issuer（**不要**带 `/.well-known/...`） |
| `AUTHENTIK_CLIENT_ID` | — | OAuth2/OpenID Provider 的 Client ID |
| `AUTHENTIK_CLIENT_SECRET` | — | Client Secret（仅环境变量） |
| `AUTHENTIK_REDIRECT_URI` | — | 完整回调地址，以 `/auth/oidc/callback` 结尾 |
| `AUTHENTIK_SCOPES` | `openid profile email` | 可选 |
| `AUTHENTIK_TOKEN_AUTH_METHOD` | 按 discovery 自动 | `client_secret_basic` / `client_secret_post` |
| `AUTHENTIK_SESSION_TTL_SECONDS` | `28800` | 远程会话最长期（300–604800） |
| `AUTHENTIK_COOKIE_SECURE` | 按回调 URL 自动 | 生产环境不要强制关闭 |
| `AUTHENTIK_POST_LOGOUT_REDIRECT_URI` | — | Authentik 登出后的返回地址 |
| `ADMIN_REMOTE_MODE` | — | 远程管理认证方式：`oidc`（默认）或 `password`；后台切换后以配置文件为准 |
| `TRUSTED_PROXY_ADDRESSES` | — | 允许提供 `X-Forwarded-For` 的反代精确 IP，逗号分隔 |

Authentik 配置要点（详见 README）：

- Provider：`Confidential` + `Authorization Code`；Redirect URI 指向
  `https://你的网关地址/auth/oidc/callback`；Scopes 含 `openid profile email`。
- Signing Key 建议选证书密钥（非对称签名，走 JWKS 校验）；**不要配置 Encryption Key**。
- 后台可进性由 Authentik Application 的 Policy/Binding 控制；能通过该 Application
  认证即拥有网关管理权限。

## 可靠性设置（后台「可靠性设置」面板）

| 设置 | 范围 | 默认 |
| --- | --- | --- |
| 上游超时 `upstreamTimeoutMs` | 1000–3600000 ms | 600000 |
| 每个上游重试次数 `upstreamRetries` | 0–10（0 不重试） | 0 |
| 最大备用尝试 `maxFallbackAttempts` | 0–12（0 不限） | 0 |
| 切换前等待 `retryDelayMs` | 0–30000 ms | 0 |
| 熔断失败阈值 `circuitBreakerFailureThreshold` | 1–20 | 3 |
| 熔断冷却 `circuitBreakerCooldownMs` | 1000–3600000 ms | 60000 |
| 最大并发请求 `maxConcurrentRequests` | 0–1000（0 不限） | 0 |
| 每 Key 每分钟请求 `requestsPerMinute` | 0–10000（0 不限） | 0 |
| 错误消息前缀 `errorPrefix` | 任意文本，最长 60 字符（留空不加） | 空字符串 |

错误消息前缀只作用于**返回给客户端的 JSON 和 SSE 错误消息**（如
400/401/404/429/502、上游流内错误及协议转换失败）；成功响应和正常流式内容不受影响。
消息格式为 `[SakuraGateway] [request_id=req_xxx] [code=400] model 不能为空`。
错误码优先使用上游 `code`，缺失时使用 HTTP 错误状态码；流内错误用 `502` 兜底，
不使用 `type` 或流式握手的 `200`。前缀留空时仍显示请求 ID 和错误码。

非法输入会回退为默认值（`normalizeSettings` 白名单校验）。

## 反向代理示例

网关只信任 socket 来源；反代必须加入可信列表，否则远程用户会被当成「未认证远程」：

```powershell
$env:TRUSTED_PROXY_ADDRESSES = "127.0.0.1"   # 反代与网关同机时
$env:HOST = "0.0.0.0"
$env:AUTHENTIK_ISSUER_URL = "https://auth.example.com/application/o/sakura-ai-gateway"
$env:AUTHENTIK_CLIENT_ID = "..."
$env:AUTHENTIK_CLIENT_SECRET = "..."
$env:AUTHENTIK_REDIRECT_URI = "https://gateway.example.com/auth/oidc/callback"
node src/server.js
```

## 配置备份与迁移

项目改名、旧环境变量、桌面数据和 Docker 卷迁移见[名称与数据迁移](migration.md)。

## 自动升级

项目的 `.github/workflows/release.yml` 会在推送匹配 `vX.Y.Z` 的 tag 时创建源码升级包：

```text
Sakura-AI-Gateway-vX.Y.Z.tar.gz
```

后台“版本与升级”会从固定 GitHub 仓库读取正式 Release。只有找到匹配版本、HTTPS 下载地址和
GitHub SHA-256 digest 时，才会显示“自动升级”。升级器会下载并校验压缩包，保留 `data/`，
备份当前程序，替换程序文件后重启；校验、解压或版本不匹配会尝试回滚。升级期间不要手动终止
Node 进程或删除 `.backup-*` 临时目录。


同一个 Release 还会包含 Windows 客户端：`WebView2-win-x64.zip`、`Electron-win-x64-Setup.exe`
和 `Electron-win-x64-Portable.exe`。前者使用 .NET 8 + Edge WebView2，后两者使用 Electron；
两种客户端都把网关 `data/` 放在用户目录中。
客户端启动时会自动选择空闲回环端口，并通过 `SAKURA_AI_GATEWAY_FORCE_HOST`、
`SAKURA_AI_GATEWAY_FORCE_PORT` 覆盖旧配置中的监听地址和端口，同时设置
`SAKURA_AI_GATEWAY_FORCE_SETTINGS=true`，避免迁移旧配置后出现启动成功但界面白屏。
- 后台可导出完整配置（`/api/admin/config/export`）与导入
  （`/api/admin/config/import`，`preserveCredentials` 控制凭据保留）。
- 导入会做模型选择与托管路由的一致性校验；旧版重复的同名选择自动合并（见
  [模型路由与轮询](routing.md)）。
- 指标文件迁移：旧版内联 `logs` 首次启动自动迁入 JSONL（见 [指标与请求日志](metrics.md)）。

## 常见运维注意

- `data/config.json` 含密钥，勿提交或分享；Client Secret 不在该文件里。
- 熔断/路由游标/余额缓存均在内存，重启即重置。
- 余额功能是手工按需查询，无定时监控/告警；用量统计不等同于上游账单。
