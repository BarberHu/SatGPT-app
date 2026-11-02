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

## 2. 创建根目录配置

```powershell
Copy-Item .env.example .env
```

先填写根目录 `.env` 并放置 GEE 凭据，再按第 4 节安装和启动。

脚本会创建 `basic-venv/` 和 `harness/.venv/` 并安装依赖；如果尚未创建 `.env`，也会复制唯一模板。

## 3. 配置 `.env`

将服务账号 JSON 放在项目根目录，命名为 `.private-key.json`，或在配置中填写其绝对路径。编辑根目录 `.env`：

```dotenv
# GEE：Basic 和 Agent 共用服务账号
GOOGLE_APPLICATION_CREDENTIALS=.private-key.json
GEE_PROJECT_ID=your-google-cloud-project-id

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

Basic 与 Agent 的模型配置相互独立，`OPENAI_API_KEY` 仍用于 Basic 问答、位置解析和数据集推荐。Agent 仅要求所选服务商的密钥；未选择服务商的字段留空。Mapbox 使用浏览器公开 token，不使用 secret token。

唯一填写入口是根目录 `.env`，唯一模板是根目录 `.env.example`。优先级为 **进程环境变量 > 根目录 `.env` > 程序默认值**，显式空值也优先（必填项会报错）。前端目录环境文件、模式专用 `.env.*` 和其他项目 JSON 不再读取。配置值不展开 `${VAR}`；含 `#`、空格、`$` 的值使用单引号。相对凭据路径始终以项目根目录解析，与启动目录无关。

模型密钥和服务账号 JSON 仅在后端使用，Git 与 Docker 构建均排除真实配置。Vite 关闭自动环境暴露，仅显式编译两个 `REACT_APP_MAPBOX_*` 公开字段。

## 4. 本地启动

安装、校验并启动开发模式（支持前端热更新）：

```powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat dev
```

打开 **http://127.0.0.1:3000/**，默认进入 Basic，点击 **Agent** 切换。

| 服务 | 默认地址 |
| --- | --- |
| 前端 | http://127.0.0.1:3000 |
| Basic API | http://127.0.0.1:8000 |
| Harness Agent API | http://127.0.0.1:8001 |

三个服务的端口均从根目录 `.env` 读取；`AGENT_PORT`、`HARNESS_PORT`、`FRONTEND_PORT` 必须互不相同。开发与生产模式共用端口，请先停止旧服务再启动另一种模式。停止时在三个服务窗口分别按 `Ctrl+C`，然后关闭窗口。

本地生产模式（构建前端并启动三个服务）：

```powershell
.\scripts\windows\satgpt.bat deploy
```

也可分别执行 `satgpt.bat build` 和 `satgpt.bat prod`。修改 Basic 模型后重启 Basic API；修改 Agent 模型后重启 Harness API（包括 SDK/worker 子进程）；修改 GEE 后重启两个 API。修改端口后重启对应 API 与前端/网关。修改 Mapbox 配置后，开发模式重启 Vite，生产模式重新构建前端并重启网关（或重新构建 Docker frontend 镜像）。构建后的浏览器文件不会读取运行期 `.env`。

## 5. 检查与排错

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8001/health
```

- **地图空白**：检查 Mapbox token、底图访问权限，重启前端是否生效。
- **GEE 认证失败**：检查凭据路径、项目 ID、API 启用状态、服务账号权限及 Google 服务的网络连接。
- **模型返回 401**：检查所选服务商与密钥是否匹配。`model_key_configured` 只表示已填写，`model_authentication=not_checked` 表示健康检查没有调用模型。Harness 的 `gee_project_configured` 也只表示已配置；通过实际 `gee_status` 工具确认认证与远端往返。Basic 的 `gee_initialized` 表示初始化结果。
- **端口占用**：先停止之前启动的服务，再重新运行启动命令。

Agent 的聊天、会话和预览保存在本地 `harness/state/`；需要保留历史时请备份该目录。

Agent 地图底部的“当前图层”卡片包含静态预览、名称、观测日期、来源与图例。眼睛开关控制显隐，详情中可查看数据集/波段/范围并定位或移除；不提供“分析当前区域”按钮。新 `gee_layer` 结果按同一渲染参数保存 PNG 缩略图，连续图例来自实际 palette/min/max，分类标签必须与连续整数类别及色板顺序对应，RGB 合成显示波段说明。观测日期未知时明确标注；旧图层只有同名预览时才关联，不推测或伪造缩略图/日期。预览失败仍可使用交互图层。地图比例尺采用横向多刻度样式，位于图层面板上方，随面板展开/收起及地图移动缩放更新，并自动切换公里/米。

## 目录与其他部署方式

```text
frontend/   React 前端与 Basic / Agent 页面
agent/      Basic API
harness/    Harness SDK、GEE 插件、Python worker 与 SSE
scripts/    Windows 启动脚本和 Docker Compose
```

Docker 和 Linux 部署见 [PRODUCTION.md](PRODUCTION.md)。当前主要面向可信用户使用，公开部署要求见该文档。
