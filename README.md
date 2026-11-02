# SatGPT

基于 Google Earth Engine（GEE）的遥感分析应用，提供两种模式：

- **Basic**：地图、洪水图层和基础问答。
- **Agent**：通过 DeepSeek Harness SDK 调用 GEE，支持流式回答、运行时间线、历史会话和分析结果图层。

前端使用 React + Mapbox；两个后端均为 Python FastAPI。当前开发基线未挂载实验 Skill。

## 1. 环境准备

- **Python 3.12**，确保 `python --version` 显示 3.12。
- **Node.js 22.12 或以上**及 npm（Vite 也支持 Node.js 20.19 系列）。
- 可用的 Mapbox token、模型 API 密钥。
- 已启用 Earth Engine API、完成 Earth Engine 注册的 Google Cloud 项目，以及有权访问该项目与所需 GEE 数据的 **service account JSON 凭据**。

先从 GitHub 获取发布分支：

```powershell
git clone --branch pro2.0 --single-branch https://github.com/BarberHu/SatGPT-app.git
cd SatGPT-app
```

下列 Windows 命令均在项目根目录的 PowerShell 中执行。

## 2. 安装依赖

```powershell
.\scripts\windows\satgpt.bat setup
```

脚本会创建 `basic-venv/` 和 `harness/.venv/`、安装 Python 与前端依赖，并在 `.env` 不存在时从 `.env.example` 创建配置文件。

## 3. 配置 `.env`

将服务账号 JSON 放在项目根目录，命名为 `.private-key.json`，或在配置中填写其绝对路径。编辑根目录 `.env`：

```dotenv
# GEE：Basic 和 Agent 共用服务账号
GOOGLE_APPLICATION_CREDENTIALS=.private-key.json
GEE_PROJECT_ID=your-google-cloud-project-id
# GEE_PROJECT 可留空；填写时应与 GEE_PROJECT_ID 一致
GEE_PROJECT=

# 地图：底图 URL 可以沿用 .env.example 中的配置
REACT_APP_MAPBOX_ACCESS_TOKEN=your-mapbox-token
REACT_APP_MAPBOX_STYLE_URL=mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp

# Basic 问答模型
OPENAI_API_KEY=your-basic-model-key
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

# Agent 模型：使用 DeepSeek 官方服务
DSH_PROVIDER=deepseek-official
DSH_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=your-deepseek-key
```

如果 Agent 使用 AIHubMix，替换上面的 Agent 配置，模型 ID 填该平台实际可用的值：

```dotenv
DSH_PROVIDER=aihubmix
DSH_MODEL=your-model-id
AIHUBMIX_API_KEY=your-aihubmix-key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
```

Basic 与 Agent 的模型配置相互独立。其余参数可以保留 `.env.example` 的默认值；日常只编辑根目录 `.env`，避免 `frontend/.env` 的同名配置覆盖它。`.env` 和服务账号密钥不应提交到 Git。

已有本地 Harness 配置时，可选设置 `DSH_LOCAL_CONFIG_FILE` 为 JSON 文件路径，它仅补齐未配置的模型字段。Windows 启动脚本也会自动发现同级 `GEE_harness/state/local-config.json`。

## 4. 本地启动

开发模式（支持前端热更新）：

```powershell
.\scripts\windows\satgpt.bat dev
```

打开 **http://127.0.0.1:3000/**，默认进入 Basic，点击 **Agent** 切换。

| 服务 | 默认地址 |
| --- | --- |
| 前端 | http://127.0.0.1:3000 |
| Basic API | http://127.0.0.1:8000 |
| Harness Agent API | http://127.0.0.1:8001 |

Windows 启动脚本的 Basic API 固定使用 8000 端口；初次部署建议保留默认端口。开发与生产模式共用端口，请先停止旧服务再启动另一种模式。停止时在三个服务窗口分别按 `Ctrl+C`，然后关闭窗口。

本地生产模式（构建前端并启动三个服务）：

```powershell
.\scripts\windows\satgpt.bat deploy
```

也可分别执行 `satgpt.bat build` 和 `satgpt.bat prod`。修改模型或 GEE 配置后重启服务；修改 Mapbox 配置后，开发模式重启前端，生产模式重新执行 `deploy`。

## 5. 检查与排错

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8001/health
```

- **地图空白**：检查 Mapbox token、底图访问权限，以及是否存在前端同名配置覆盖。
- **GEE 认证失败**：检查凭据路径、项目 ID、API 启用状态、服务账号权限及 Google 服务的网络连接。
- **模型返回 401**：检查所选服务商与密钥是否匹配。健康接口显示密钥已配置，不代表模型调用验证成功。
- **端口占用**：先停止之前启动的服务，再重新运行启动命令。

Agent 的聊天、会话和预览保存在本地 `harness/state/`；需要保留历史时请备份该目录。

## 目录与其他部署方式

```text
frontend/   React 前端与 Basic / Agent 页面
agent/      Basic API
harness/    Harness SDK、GEE 插件、Python worker 与 SSE
scripts/    Windows 启动脚本和 Docker Compose
```

Docker 和 Linux 部署见 [PRODUCTION.md](PRODUCTION.md)。当前主要面向可信用户使用，公开部署要求见该文档。
