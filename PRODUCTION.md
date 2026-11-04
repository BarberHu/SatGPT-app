# SatGPT 生产部署

统一填写根目录 `.env`（从唯一模板 `.env.example` 复制）。环境变量优先于 `.env`，未设置的高级参数使用程序默认值；凭据路径相对项目根目录，与启动目录无关。Basic 和 Agent 的模型密钥独立；仅需所选 Agent 服务商的密钥。不读取前端环境文件或其他项目的 local-config JSON。

## Windows / Node 网关

```powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat deploy
```

默认访问 http://127.0.0.1:3000/。统一后端与前端端口分别由 `AGENT_PORT`（默认 8000）、`FRONTEND_PORT`（默认 3000）配置。`satgpt_config.py backend` 是唯一默认 API 启动入口，`AGENT_WORKERS=1` 为强制要求；也支持从任意目录用脚本绝对路径启动。Node 网关和 Vite 使用同一 `frontend/projectEnv.cjs` 加载根目录配置。

## Docker Compose

需要 Docker Engine 和 Compose v2。以下命令从项目根目录执行，**保留 `--project-directory .`**：它让构建和凭据的相对路径均以根目录为准。

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml ps
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml logs --tail 100 -f
```

不要将不带 `--quiet` 的 Compose 展开配置写入日志或提交，它包含运行环境中的密钥。CI/系统环境注入通过 Compose 显式变量映射覆盖根目录 `.env`。若需要网络代理，容器内的 `127.0.0.1` 指向容器自身；通过系统环境覆盖为容器可达的代理地址。含 `$` 的密钥在 `.env` 中用单引号包裹，避免 Compose 插值。

GEE 凭据使用 `GOOGLE_APPLICATION_CREDENTIALS` 指定的宿主机文件（默认 `.private-key.json`，也支持绝对路径），只读挂载到统一后端的 `/run/secrets/gee-service-account.json`。不存在时拒绝启动，不自动创建目录。容器内主机地址固定为 `0.0.0.0`；端口仍遵循 `.env`，仅前端端口发布到宿主机 `127.0.0.1`。网关通过 Compose 内部 `agent` 服务名访问 API，不使用宿主机地址。两种部署都使用 Node 网关，避免另一份固定端口的 Nginx 配置。

前端镜像仅接收两个公开 Mapbox build args，既不接收模型密钥也不复制 `.env`。后端运行时注入凭据和所需模型配置。真实配置、服务账号 JSON、实验目录、测试运行结果、输出文件、运行历史和本地虚拟环境被构建上下文排除。`harness_state` 卷保存会话；停止命令不删除卷：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml down
```

## 修改配置与健康检查

- Basic 或 Agent 模型：重启统一后端（包含 DSH 与 Python worker），各自模型与密钥仍独立。
- GEE 配置或凭据：重启统一后端；网络代理修改也需要重启相关进程。
- 服务端口：重启 API 与前端/网关。Compose 使用同一命令 `up -d --build` 重新应用。
- Mapbox：开发模式重启 Vite；生产模式必须重新构建前端/镜像，随后重启网关。其他后端配置无需重新构建浏览器文件。

`/readyz` 验证网关能访问统一后端并读取两模块的本地初始化状态，任一未初始化返回 503；后端和 Vite 也提供同一路径。`/health` 保留 Basic 字段，并增加 Harness 兼容字段及独立的 `basic`/`harness` 对象；Harness 原健康信息见 `/api/harness/health`。就绪检查只表示本地生命周期完成，不要求模型调用成功或 GEE 可用。`configured` 字段只表示填入配置，`model_authentication=not_checked` 和 Harness 的 `gee_authentication=not_checked` 不代表认证成功。Basic 的 `gee_initialized` 是初始化结果；实际调用 Basic 问答、Harness 对话和 `gee_status` 才验证模型/远端 GEE 通路。

## 发布范围

当前修改应在 `pro2.0` 分支审阅并按文件选择提交。不要提交 `.env`、服务账号 JSON、`harness/state/`、`outputs/`、实验文件或构建结果；测试与验证产物保留在本地忽略目录。提交前检查 `git diff --cached --name-only` 与密钥扫描结果，勿使用无审查的全目录暂存。

## 公开部署

当前为可信用户应用。公开部署前需增加身份认证、用户隔离、TLS、GEE/模型限额、生成代码执行隔离及审计；不要直接发布后端端口。多副本部署前应替换本机文件会话存储。前端需监听其他地址时显式设置 `SATGPT_ALLOW_REMOTE_HARNESS=true` 和 `FRONTEND_HOST`。

## 从双后端迁移

Basic 业务模块目录现为 `basic/`，导入改用 `basic`；模块内数据集注册表和水体目录缓存随目录一起保留。HTTP API 路径、`AGENT_PORT`、Compose 服务名 `agent` 及 Harness 会话路径均保持兼容。

1. 停止旧 Basic、Harness 和前端进程，备份 `.env`、`harness/state/`。不要覆盖原配置、删除会话或删除 Docker 卷。
2. 执行 `scripts\windows\satgpt.bat setup`，安装到唯一的 `harness/.venv/`。唯一依赖清单为根目录 `requirements.txt`，其中同时固定已验证的直接及间接依赖版本，并保留平台条件；升级时更新这一个文件并执行回归测试。Linux 镜像仍须实际构建验证，Windows 安装成功不等于容器已验证。模块内旧依赖清单已移除，旧安装命令统一改为在根目录执行 `python -m pip install -r requirements.txt`。
3. 保留 `AGENT_PORT`、`AGENT_HOST`；删除已忽略的 `HARNESS_PORT`、`HARNESS_HOST`。网关删除旧 `BASIC_SERVICE_HOST` / `HARNESS_SERVICE_HOST`，统一使用 `SATGPT_SERVICE_HOST`。`AGENT_WORKERS` 必须是 1。
4. 运行 `satgpt_config.py check`，再用 `satgpt.bat dev`，或 `build` 后 `prod` 启动。标准后端命令为 `.\harness\.venv\Scripts\python.exe satgpt_config.py backend`。旧 `basic` / `harness` 子命令及 `cd harness; python -m app` 提示迁移后同样启动统一服务，不能同时运行。
5. 用上面的就绪/健康接口以及实际业务确认迁移。随后可自行删除不再引用的 `basic-venv/`，不要删除 `harness/.venv/` 或 `harness/state/`。

Compose 沿用原 `agent` 服务名及 `harness_state:/app/harness/state` 卷挂载点；后端仅使用根目录 `Dockerfile`，旧的模块镜像副本已移除，直接构建命令改为根目录 `docker build -f Dockerfile .`，不再启动第二个服务。迁移前使用相同项目名执行以下停止命令，移除旧服务容器并保留卷，然后使用本文的 `up -d --build`：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml down --remove-orphans
```

不要添加 `-v`；项目名变化会选择另一个卷。宿主机的 `harness/state/` 与 Docker 命名卷仍是各自的数据目录，本次不自动复制它们。直接执行 `python basic/server.py` 或使用 `uvicorn server:app` / `app.server:app` 的方式需迁移到标准入口，或根目录 `python -m uvicorn satgpt_backend:app --workers 1`。

## 运行边界

Python 组件统一直接使用 `satgpt_config.py`，瓦片组件也遵循同一配置优先级、禁止变量展开及根目录相对路径规则，不再单独解析 `.env`。两份 `server.py` 只导出 `APIRouter`、处理函数及生命周期钩子；`satgpt_backend.py` 是唯一创建 FastAPI 应用的位置。统一后端通过两个模块的路由和显式组合生命周期集成，各模块初始化一次、按相反顺序关闭；初始化失败会反向清理已进入的生命周期，关闭时取消 Agent 任务、关闭 SDK/工具进程并等待线程池退出。SDK/工具 worker 在首次任务/工具调用时按需启动；就绪检查不能据此声称它们已通过外部认证。Basic 的 GEE 初始化在线程内进行，失败时健康为 degraded，问答仍可使用其独立模型。

Basic 的重任务信号量保留，主要限制同步 GEE 请求与瓦片获取的并发，遥感计算在 GEE 云端。目录组件原有的随机端口瓦片 HTTP 服务改为统一 `/api/ee-tiles/...`，保留响应中的 URL 字段。两个模式共享 HTTP 进程、资源和故障范围；Basic 的线程请求、Harness 的同步 HTTP 操作及 SSE 等待仍会竞争线程/连接资源。工具代码继续在独立进程执行，未引入数据库、消息队列或分布式任务框架。

仅支持单 worker、单后端副本。任务和业务图层缓存仍在内存，重启会丢失这些状态；已有会话文件继续保存在原位置。两边不再可以独立重启。本次合并不承诺模型速度、GEE 计算速度或内存占用改善。

## 回归验证命令

从根目录执行：

```powershell
.\harness\.venv\Scripts\python.exe -m pip check
.\harness\.venv\Scripts\python.exe -m unittest discover -s harness/tests -p test_*.py
.\harness\.venv\Scripts\python.exe -m unittest discover -s scripts/tests -p test_*.py
$env:PYTHON = (Resolve-Path harness/.venv/Scripts/python.exe).Path
node --test scripts/tests/gateway.test.cjs harness/tests/worker-client.test.mjs harness/tests/plugin.test.mjs harness/tests/assistant-stream.test.mjs
.\scripts\windows\satgpt.bat build
```

集成测试使用临时会话目录，替换外部模型/GEE 调用，覆盖单轮问答、历史/热点接口传输和错误、Agent 对话/任务/取消/SSE、后台执行时 Basic 响应、重任务限流、生命周期失败清理及独立 Python worker；它们不证明真实模型或 GEE 数据产品正确。网关测试需要已有前端 build，Windows 测试需要可用的本机回环套接字。
