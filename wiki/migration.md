# Sakura-AI-Gateway 名称与数据迁移

项目由 **Local Model Gateway / Local-Model-Gateway** 更名为 **Sakura-AI-Gateway**。
项目名称和程序标识已统一更新；Git 历史、既有 tag、历史 Release 及其文件名不改写。
许可证、配置文件结构、模型名、本地 Key、上游凭据和历史用量记录不因改名而变化。

## 新名称

- 官方仓库：<https://github.com/Guyao146/Sakura-AI-Gateway>
- npm 包名 / 服务标识：`sakura-ai-gateway`
- 镜像：`ghcr.io/guyao146/sakura-ai-gateway`（使用正式发布后实际存在的标签）
- Windows 包和源码包前缀：`Sakura-AI-Gateway-`
- 环境变量：`SAKURA_AI_GATEWAY_*`

## 环境变量与源码运行

`SAKURA_AI_GATEWAY_DATA_DIR`、`MAX_LOGS`、`FORCE_HOST`、`FORCE_PORT`、`FORCE_SETTINGS`
均兼容对应的 `LOCAL_MODEL_GATEWAY_*` 旧变量。新旧同时存在时，新名称优先；新变量显式设置
为空或 `false` 也不会重新启用旧值。新部署只使用新名称。

源码运行的默认 `data/` 目录不变。移动项目文件夹时请连同 `data/` 一起移动；如果使用绝对
数据路径，更新环境变量指向原有数据。不要对配置 JSON 中的模型 ID 或用户内容做全局替换。

## 桌面客户端

升级前退出新旧客户端并备份数据；首次运行新版本时：

- WebView2 / 本地构建客户端：`%LOCALAPPDATA%\LocalModelGateway` → `%LOCALAPPDATA%\Sakura-AI-Gateway`。
- Electron：`%APPDATA%\Local Model Gateway Electron`（开发版可能是 `local-model-gateway-electron`）
  → `%APPDATA%\Sakura-AI-Gateway Electron`。
- 仅当新目录不存在时复制整个旧目录（含配置、用量日志、端口设置和浏览器数据）；复制完成后
  原子切换到新目录。旧目录保留作为备份，已有新目录不会被覆盖。复制失败会报错而不是悄悄
  使用空配置。新旧客户端不要同时写入同一份数据。
- 安装器和应用标识已更名，操作系统可能将其视作新应用；确认迁移成功后再卸载旧程序。

## 浏览器

同源访问时，旧的 `local-model-gateway.*` 标签页/排序偏好在新键不存在时复制到
`sakura-ai-gateway.*`，不覆盖新版偏好。域名或端口改变时，浏览器存储受同源策略限制，
不会跨源搬运。管理 Cookie 改为 `sakura_ai_gateway_admin_session` / `sakura_ai_gateway_oidc_state`，
升级重启后需要重新登录；进行中的 OIDC 登录应重新发起。已配置的 OIDC issuer/回调地址
保持原值，不要仅因项目改名就改动服务商分配的地址。

## Docker：必须先确认数据卷

GHCR 镜像仓库改名不会自动搬迁旧镜像或数据卷。历史镜像继续留在
`ghcr.io/guyao146/local-model-gateway`；新版工作流只发布新仓库。

新版 Compose 使用可配置的显式卷名（新安装默认 `sakura-ai-gateway-data`），防止以后换目录
再次创建空卷。已有部署升级前，在**旧目录/原 Compose 项目**下检查：

```bash
container=$(docker compose ps -q gateway)
docker inspect "$container" --format '{{range .Mounts}}{{println .Name .Destination}}{{end}}'
```

找出挂载到 `/app/data` 的原卷（常见名为 `local-model-gateway_gateway-data`，以实际输出为准），
备份后将 `.env` 中的 `SAKURA_AI_GATEWAY_VOLUME` 设置为**这个实际卷名**。不要盲目使用新默认值。
在旧项目下执行 `docker compose down` 停止旧容器（**不要加 `-v`**），再在新目录拉取并启动。
不要让两个网关进程同时写同一卷。确认配置和用量完整前不要删除旧卷。

## 更新检查与发布

更新检查使用新仓库，自动升级只识别带有效 SHA-256 的新名称源码包。
改名前版本的更新器只识别旧文件名前缀，第一次跨名称升级请备份后手动更新，或安装新版桌面
客户端；后续新名称发布可继续使用自动升级。仅修改源码不等于已发布镜像或安装包。