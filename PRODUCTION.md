# SatGPT 生产部署

统一填写根目录 `.env`（从唯一模板 `.env.example` 复制）。环境变量优先于 `.env`，未设置的高级参数使用程序默认值；凭据路径相对项目根目录，与启动目录无关。Basic 和 Agent 的模型密钥独立；仅需所选 Agent 服务商的密钥。不读取前端环境文件或其他项目的 local-config JSON。

## Windows / Node 网关

```powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat deploy
```

默认访问 http://127.0.0.1:3000/。Basic、Harness 和前端端口分别由 `AGENT_PORT`、`HARNESS_PORT`、`FRONTEND_PORT` 配置。`satgpt_config.py basic/harness` 是 API 启动入口；也支持从任意目录用脚本绝对路径启动。Node 网关和 Vite 使用同一 `frontend/projectEnv.cjs` 加载根目录配置。

## Docker Compose

需要 Docker Engine 和 Compose v2。以下命令从项目根目录执行，**保留 `--project-directory .`**：它让构建和凭据的相对路径均以根目录为准。

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml ps
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml logs --tail 100 -f
```

不要将不带 `--quiet` 的 Compose 展开配置写入日志或提交，它包含运行环境中的密钥。CI/系统环境注入通过 Compose 显式变量映射覆盖根目录 `.env`。若需要网络代理，容器内的 `127.0.0.1` 指向容器自身；通过系统环境覆盖为容器可达的代理地址。含 `$` 的密钥在 `.env` 中用单引号包裹，避免 Compose 插值。

GEE 凭据使用 `GOOGLE_APPLICATION_CREDENTIALS` 指定的宿主机文件（默认 `.private-key.json`，也支持绝对路径），只读挂载到两个后端的 `/run/secrets/gee-service-account.json`。不存在时拒绝启动，不自动创建目录。容器内主机地址固定为 `0.0.0.0`；端口仍遵循 `.env`，仅前端端口发布到宿主机 `127.0.0.1`。网关通过 Compose 内部 `agent`/`harness` 服务名访问 API，不使用宿主机地址。两种部署都使用 Node 网关，避免另一份固定端口的 Nginx 配置。

前端镜像仅接收两个公开 Mapbox build args，既不接收模型密钥也不复制 `.env`。后端运行时注入凭据和所需模型配置。真实配置、服务账号 JSON、实验目录、测试运行结果、输出文件、运行历史和本地虚拟环境被构建上下文排除。`harness_state` 卷保存会话；停止命令不删除卷：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml down
```

## 修改配置与健康检查

- Basic 模型：重启 Basic API；Agent 模型：重启 Harness（包含 DSH 与 Python worker）。
- GEE 配置或凭据：重启两个 API；网络代理修改也需要重启相关进程。
- 服务端口：重启 API 与前端/网关。Compose 使用同一命令 `up -d --build` 重新应用。
- Mapbox：开发模式重启 Vite；生产模式必须重新构建前端/镜像，随后重启网关。其他后端配置无需重新构建浏览器文件。

`/readyz` 验证网关能访问两个 API；`/health` 代理 Basic 健康接口；Harness 健康可直接访问其本机端口。`configured` 字段只表示填入配置，`model_authentication=not_checked` 和 Harness 的 `gee_authentication=not_checked` 不代表认证成功。Basic 的 `gee_initialized` 是初始化结果；实际调用 Basic 问答、Harness 对话和 `gee_status` 才验证模型/远端 GEE 通路。

## 发布范围

当前修改应在 `pro2.0` 分支审阅并按文件选择提交。不要提交 `.env`、服务账号 JSON、`harness/state/`、`outputs/`、实验文件或构建结果；测试与验证产物保留在本地忽略目录。提交前检查 `git diff --cached --name-only` 与密钥扫描结果，勿使用无审查的全目录暂存。

## 公开部署

当前为可信用户应用。公开部署前需增加身份认证、用户隔离、TLS、GEE/模型限额、生成代码执行隔离及审计；不要直接发布两个后端端口。多副本部署前应替换本机文件会话存储。前端需监听其他地址时显式设置 `SATGPT_ALLOW_REMOTE_HARNESS=true` 和 `FRONTEND_HOST`。
