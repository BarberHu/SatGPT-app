# SatGPT

[English](README.md) | **简体中文**

SatGPT 是基于 Google Earth Engine（GEE）的遥感分析应用，将交互地图、静态数据图层与智能分析助手结合，支持查询数据集、执行分析，并以地图图层和图表呈现结果。

应用提供 **Static layers（Basic，静态图层）** 和 **Intelligent analysis（Agent，智能分析）** 两种模式。两者共用持续挂载的一个 Mapbox 地图和当前视野，同时分别保留各自的分析状态。

## 功能

| 领域 | 能力 |
| --- | --- |
| Basic 分析 | 地图浏览、洪水相关图层、网格与绘制区域选择，以及基础问答。 |
| Agent 分析 | 通过 DeepSeek Harness SDK 搜索 GEE 数据集、查询覆盖范围和统计值、生成影像预览及交互结果图层。 |
| 对话 | 流式回答、有序运行时间线、历史会话保存、运行中切换对话，以及停止运行中或排队中的任务。 |
| 结果图层 | 按对话隔离图层，提供缩略图、观测日期、来源、图例、显隐控制、定位与移除。 |
| 图表 | 回答完成后渲染交互式 ECharts 图表，支持复制配置和导出 PNG。 |
| 共享工作区 | 模式切换时保留地图，支持调整聊天与地图面板大小、窄屏视图、比例尺和地图截图。 |

网格选择通过被点击要素的 `FID` 获取原始 GeoJSON 中的完整坐标。选区显示与分析请求使用同一份完整几何范围，不受地图缩放和瓦片裁切影响。

## 架构

| 组件 | 技术与职责 |
| --- | --- |
| `frontend/` | React、Vite、Mapbox GL JS、Streamdown 和 ECharts；提供共享地图及 Basic/Agent 界面。 |
| `basic/` | Basic Python 业务模块，负责分析与问答，由统一 API 集成。 |
| `harness/` | Python FastAPI 后端、DeepSeek Harness SDK、GEE 工具插件、Python worker 和服务器发送事件（SSE）。 |
| `scripts/` | Windows 安装与启动脚本，以及 Docker Compose 部署配置。 |

当前基线未注册实验性 Skill。Agent 任务通过一个队列执行；切换对话后，原任务在后台继续，并将结果保存到原对话。

## 环境要求

- **Python 3.12**，确保 `python --version` 显示 3.12。
- **Node.js 22.12 或以上**及 npm；安装脚本也接受受支持的 Node.js 20.19+ 版本系列。
- 有权访问所配置底图样式的 Mapbox 浏览器公开 token。
- Basic 和所选 Agent 服务商的模型 API 密钥。
- 已完成 Earth Engine 注册、启用 Earth Engine API 的 Google Cloud 项目，以及有权访问该项目和所需 GEE 数据的 **service account JSON 凭据**。

下列 Windows 命令均在项目根目录的 PowerShell 中执行。

## 快速开始

### 1. 获取发布分支

```powershell
git clone --branch pro2.0 --single-branch https://github.com/BarberHu/SatGPT-app.git
cd SatGPT-app
```

### 2. 创建配置文件

```powershell
Copy-Item .env.example .env
```

将服务账号 JSON 放在项目根目录，命名为 `.private-key.json`，或将 `GOOGLE_APPLICATION_CREDENTIALS` 设置为其绝对路径。启动前填写根目录 `.env`。

### 3. 配置凭据与模型

填写共用的 GEE 和地图配置，再分别填写 Basic 和 Agent 模型配置：

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=.private-key.json
GEE_PROJECT_ID=your-google-cloud-project-id

REACT_APP_MAPBOX_ACCESS_TOKEN=your-mapbox-public-token
REACT_APP_MAPBOX_STYLE_URL=mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp

OPENAI_API_KEY=your-basic-model-key
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

DSH_PROVIDER=deepseek-official
DSH_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=your-deepseek-key
```

以上模型名称与仓库默认配置一致，请确认所选服务商支持你填写的模型。如果 Agent 使用 AIHubMix，将 Agent 配置替换为：

```dotenv
DSH_PROVIDER=aihubmix
DSH_MODEL=your-model-id
AIHUBMIX_API_KEY=your-aihubmix-key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
```

Basic 与 Agent 的模型配置相互独立。`OPENAI_API_KEY` 用于 Basic 问答、位置解析和数据集推荐。Agent 仅要求所选服务商的密钥，未使用的服务商密钥留空。Mapbox 使用浏览器公开 token，不使用 secret token。

推理强度、输出长度、端口和网络等可选设置见 [`.env.example`](.env.example)。

### 4. 安装、校验并启动

```powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat dev
```

安装脚本仅创建或复用 `harness/.venv/`，仅按根目录 `requirements.txt` 安装两边的 Python 依赖及前端依赖，并在 `.env` 不存在时复制配置模板。开发模式支持前端热更新。配置校验只检查本地设置，不代表模型或 GEE 已认证成功。

打开 **[http://127.0.0.1:3000/](http://127.0.0.1:3000/)**。

| 服务 | 默认地址 |
| --- | --- |
| 前端 | [http://127.0.0.1:3000](http://127.0.0.1:3000) |
| 统一 Basic + Harness API | [http://127.0.0.1:8000](http://127.0.0.1:8000) |

`FRONTEND_PORT` 和 `AGENT_PORT` 从根目录 `.env` 读取，且必须不同。旧 `HARNESS_PORT`、`HARNESS_HOST` 已忽略，请删除；`AGENT_WORKERS` 必须为 `1`。开发与生产使用相同的配置端口，切换启动模式前先停止旧服务。停止 Windows 服务时，在两个服务窗口分别按 `Ctrl+C`，然后关闭窗口。

## 使用 SatGPT

1. 在 **Static layers** 中浏览地图、选择网格或绘制区域，并使用 Basic 分析。选择网格会加载原始完整网格范围的数据。
2. 切换到 **Intelligent analysis**，向 Agent 询问当前地图区域或其他明确指定的地点，并查看流式回答与运行时间线。
3. 任务运行中可通过历史列表打开其他对话或新建对话。切回运行中的对话会恢复任务订阅，新任务仍受共用执行队列调度。
4. 点击方形 **Stop response** 按钮，取消运行中或排队中的任务。任务记录为 **Stopped**，适用时关闭其运行进程，随后可继续提问。停止操作不要求输入框有文字或地图可用。
5. 在结果图层卡片中查看缩略图、观测日期、来源和图例，控制显隐、查看详情、定位或移除图层。未知日期会明确标注；缩略图失败不影响交互图层的使用。
6. 需要时请求生成图表。有效的小写 `echarts` JSON 代码块在回答完成后渲染，支持复制图表配置和导出 PNG；无效配置会显示源内容及错误。仅开发模式提供预览页面：[http://127.0.0.1:3000/?review=echarts](http://127.0.0.1:3000/?review=echarts)。
7. 地图就绪后，使用截图按钮保存共享地图当前画面。窄屏设备需先打开 Agent 地图视图。

模式切换保留地图和视角，不重载底图，也不自动定位结果。Agent 图层按对话隔离。比例尺随地图移动、缩放及面板尺寸更新，并自动切换米和公里。

界面统一使用英文，日期和数字采用 `en-US`，距离使用 `m` / `km`。底图优先使用英文地名，缺失时保留原地名。Basic 摘要、Agent 回答、图层名称与图例默认使用英文，用户明确要求其他语言时遵循其要求。已有消息、图层元数据和用户输入不会被自动翻译。**Settings** 目前为预留入口，不接收或保存个人 API 密钥。

## 配置与本地数据

- 根目录 `.env` 是唯一配置入口，[`.env.example`](.env.example) 是其模板。优先级为 **进程环境变量 > 根目录 `.env` > 程序默认值**。显式空值同样优先，必填项为空时校验失败。
- 不读取前端环境文件、模式专用 `.env.*` 或其他项目的配置 JSON。配置值不展开 `${VAR}`，含 `#`、空格或 `$` 的值使用单引号。
- 相对凭据路径始终以项目根目录解析，与启动目录无关。
- 模型密钥和服务账号 JSON 仅在后端使用，Git 与 Docker 构建排除真实配置。Vite 仅公开显式选定的两个 `REACT_APP_MAPBOX_*` 字段。
- Agent 对话、会话数据和预览保存在 `harness/state/`，保留历史时请备份该目录。

## 生产部署

Windows 本地生产构建与启动：

```powershell
.\scripts\windows\satgpt.bat deploy
```

也可通过相同脚本路径分别执行 `satgpt.bat build` 和 `satgpt.bat prod`。

使用 Docker Engine 和 Compose v2 时，先配置根目录 `.env` 与凭据，再从项目根目录运行：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
```

保留 `--project-directory .`，确保构建和凭据路径正确解析。仅前端端口发布到宿主机回环地址，后端保留在容器网络中。`harness_state` 卷保存对话数据。

| 修改的设置 | 所需操作 |
| --- | --- |
| Basic 模型 | 重启统一后端。 |
| Agent 模型 | 重启统一后端，包括其 SDK 与 worker 进程。 |
| GEE 配置或凭据 | 重启统一后端。 |
| 服务端口 | 重启后端与前端/网关。 |
| Mapbox 配置 | 开发模式重启 Vite；生产模式重新构建前端并重启网关，或重新构建 Docker frontend 镜像。 |

构建后的浏览器文件不读取运行期 `.env`。使用 `config --quiet`，避免输出可能包含密钥的 Compose 展开配置。详细部署说明见中文版 [PRODUCTION.md](PRODUCTION.md)。

应用当前面向可信用户。公开部署前需增加身份认证、用户隔离、TLS、GEE/模型限额、生成代码执行隔离和审计；后端端口应保持私有。多副本部署前需替换本地文件会话存储。

## 健康检查与排错

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8000/api/harness/health
Invoke-RestMethod http://127.0.0.1:3000/readyz
```

Vite 和生产网关均只代理到统一后端。`/readyz` 检查两模块本地生命周期是否完成，任一未完成返回 503；`/health` 保留 Basic 兼容字段并增加 Harness 字段及 `basic`、`harness` 独立明细。即使 GEE 不可用，本地组件仍可就绪；模型认证保持 `not_checked`，Basic 的 `gee_initialized` 单独报告 GEE 初始化结果。Harness 的 SDK 和工具进程在任务中按需启动，健康检查不声称它们已完成外部认证。

| 现象 | 检查内容 |
| --- | --- |
| 地图空白 | Mapbox 公开 token、底图访问权限，以及前端配置变更是否生效。 |
| GEE 认证失败 | 凭据路径、项目 ID、API 注册/启用状态、服务账号权限及 Google 服务的网络连接。 |
| 模型返回 401 | 所选服务商及其对应的 API 密钥。 |
| 端口被占用 | 重启前先停止之前启动的服务。 |
| 长时间闲置后结果瓦片加载失败 | GEE 地图链接为临时链接，重新查询以获取可用链接。 |
| 停止按钮或对话切换仍表现为旧版本 | 更新代码后重启统一后端并刷新页面。 |

`model_key_configured` 和 `gee_project_configured` 仅表示配置已填写。`model_authentication=not_checked` 和 Harness 的 `gee_authentication=not_checked` 表示尚未进行远端认证检查。Basic 的 `gee_initialized` 表示初始化状态。通过实际查询和 Agent 的 `gee_status` 工具验证远端访问。

## 项目结构

```text
frontend/             React 前端、共享地图、Basic/Agent 页面与图表
basic/                Basic 路由、单轮问答、地图业务与 GEE 组件
harness/app/          Agent API、控制器、SDK 适配器与 Python worker
harness/integrations/ GEE 工具和流式输出集成
scripts/windows/      Windows 安装、开发与生产命令
scripts/docker/       Docker Compose 配置
satgpt_backend.py     统一 FastAPI 应用及组合生命周期
satgpt_config.py      共用配置校验与 API 启动入口
requirements.txt      统一直接及间接依赖，固定到已验证版本
.env.example          根目录配置模板
```

## 后端迁移与限制

Basic 包目录已改名为 `basic/`，Python 导入统一使用 `basic`。现有 API 路径（包括 `/api/agent-raster-*`）及 `AGENT_PORT` 保持不变；Compose 中的 `agent` 服务名继续表示统一后端。

根目录 `Dockerfile` 是唯一后端镜像定义，直接构建使用 `docker build -f Dockerfile .`；前端继续使用自己的 `frontend/Dockerfile`。Python 组件直接从 `satgpt_config.py` 读取共享配置，不再保留仅转发导入的配置文件。

更新后先运行一次 `scripts\windows\satgpt.bat setup`，将依赖合并到 `harness/.venv/`。仅安装 Python 时执行 `harness\.venv\Scripts\python.exe -m pip install -r requirements.txt`，然后执行 `-m pip check`。模块内的旧依赖清单已移除，统一从项目根目录安装。这一份文件同时固定直接与间接依赖版本，并保留平台条件；升级依赖时更新清单并执行回归检查。不要同时运行两条后端启动命令。

标准后端命令为 `harness\.venv\Scripts\python.exe satgpt_config.py backend`。旧 `satgpt_config.py basic` / `harness` 和 `cd harness; python -m app` 均提示迁移并启动统一后端。原来直接使用 `python basic/server.py` 或 `uvicorn server:app` / `uvicorn app.server:app` 的命令请替换为标准入口，或在根目录执行 `python -m uvicorn satgpt_backend:app --workers 1`。两份 `server.py` 仅导出路由和生命周期钩子，不创建应用；唯一 FastAPI 应用由 `satgpt_backend.py` 创建，测试同样使用这个统一应用。模块文件不再是可直接执行的服务入口。删除 `BASIC_SERVICE_HOST` / `HARNESS_SERVICE_HOST`，网关只读取 `SATGPT_SERVICE_HOST` 和 `AGENT_PORT`。

现有 `.env`、凭据、`harness/state/`、浏览器图层记录及 `basic-venv/` 均保留。停止旧服务并验证新启动流程后，可自行删除仅包含旧 Python 环境的 `basic-venv/`；保留 `harness/.venv/` 和 `harness/state/`。Compose 迁移先停止旧栈，不加 `-v`，继续使用原项目名及 `harness_state` 卷，详见 [PRODUCTION.md](PRODUCTION.md)。

Basic 保持单轮语义及独立模型配置；Harness 保留多轮本地会话、后台任务线程池和使用同一解释器的独立 Python 工具进程。Basic 并发信号量继续限制同步 GEE 请求构建、瓦片获取等操作，并在线程中执行；主要遥感计算仍在 GEE 云端。原来随机端口的瓦片代理并入 `/api/ee-tiles/...`，不再额外监听 HTTP 端口。

两个模式共享 HTTP 进程、线程资源、内存和故障范围，重启后端会同时中断两边。任务状态与业务图层缓存仍在内存；必须采用单 worker、单后端副本，本地会话文件不支持多进程一致性。本次合并不承诺模型/GEE 响应或内存占用一定改善。

## 更多文档

- [生产部署与公开托管要求](PRODUCTION.md)（中文）。
- [部署脚本](scripts/README.md)（中文）。
- [共享地图架构](frontend/src/map/README.md)（英文）。
- [图表集成与第三方归属说明](frontend/src/harness/echarts/README.md)（英文）。

图表集成包含第三方校验器代码，其[许可证](frontend/src/harness/echarts/vendor/LICENSE)与[归属声明](frontend/src/harness/echarts/vendor/NOTICE)随代码保留。重新分发这部分代码时，请保留这些归属文件。
