# SatGPT Flood Analysis Platform 部署文档

适用项目：`E:\GMS\Flood\SatGPT-app`  
适用系统：Windows 10/11 x64  
文档基准环境：2026-04-29，本机已验证环境

## 1. 部署目标

本项目不是单一前端或单一后端，而是一个三服务联动的洪涝遥感分析平台：

```text
React 前端 :3000
    |
    | /api、旧版 Flask 兼容接口
    v
FastAPI Agent :8000  -> LangGraph / GEE / Tavily / OpenAI
    ^
    |
    | /copilotkit
    |
CopilotKit Runtime :5000
```

当前推荐启动链路以仓库脚本为准：

- `scripts\windows\setup_windows.bat`：初始化 Python 虚拟环境、安装 Python/Node 依赖、生成 `.env`
- `scripts\windows\start_windows.bat`：启动 FastAPI Agent、CopilotKit Runtime、React Frontend
- `start_all.bat`：兼容入口，内部转调 `scripts\windows\start_windows.bat`

`app.py` 里的 Flask 服务仍保留，主要承担历史接口和兼容逻辑；当前一键启动脚本默认不单独启动 Flask 主服务。

## 2. 明确下载版本

为了避免“能跑但不可复现”的环境漂移，本项目建议锁定以下版本。

| 软件 | 推荐版本 | 本机实测版本 | 下载地址 |
|---|---:|---:|---|
| Python | 3.12.10 x64 | 3.12.10 | https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe |
| Node.js | 22.16.0 x64 | 22.16.0 | https://nodejs.org/dist/v22.16.0/node-v22.16.0-x64.msi |
| npm | Node.js 内置 | 10.9.2 | 随 Node.js 22.16.0 安装 |
| pip | 安装后升级 | 26.0.1 | 通过 `python -m pip install --upgrade pip` 获得 |

本机路径参考：

```powershell
python --version
# Python 3.12.10

node --version
# v22.16.0

npm --version
# 10.9.2

where.exe python
# D:\Python\python.exe

where.exe node
# D:\NVM\nvm\nodejs\node.exe
```

如果使用 `nvm-windows` 管理 Node.js，可以安装并切换到同版本：

```powershell
nvm install 22.16.0
nvm use 22.16.0
node --version
npm --version
```

## 3. 安装基础环境

### 3.1 安装 Python 3.12.10

1. 下载 `python-3.12.10-amd64.exe`
2. 安装时勾选 `Add python.exe to PATH`
3. 建议选择 `Install for all users`
4. 安装后重新打开 PowerShell，验证：

```powershell
python --version
py --version
```

期望输出：

```text
Python 3.12.10
Python 3.12.10
```

### 3.2 安装 Node.js 22.16.0

1. 下载 `node-v22.16.0-x64.msi`
2. 按默认选项安装
3. 安装后重新打开 PowerShell，验证：

```powershell
node --version
npm --version
```

期望输出：

```text
v22.16.0
10.9.2
```

### 3.3 可选：设置 npm 镜像

本机当前 npm registry 是：

```text
https://registry.npmmirror.com/
```

国内网络环境建议设置：

```powershell
npm config set registry https://registry.npmmirror.com/
npm config get registry
```

如果需要完全使用 npm 官方源：

```powershell
npm config set registry https://registry.npmjs.org/
```

## 4. 获取项目代码

进入目标目录：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app
```

如果是在新机器上部署，应先通过 Git 拉取项目：

```powershell
git clone <你的仓库地址> SatGPT-app
Set-Location .\SatGPT-app
```

确认关键文件存在：

```powershell
dir requirements.txt
dir frontend\package.json
dir runtime\package.json
dir scripts\windows\setup_windows.bat
dir scripts\windows\start_windows.bat
```

## 5. 初始化项目依赖

### 5.1 推荐方式：执行 Windows 初始化脚本

这是 ROI 最高的方式，脚本会做 6 件事：

```text
1. 创建 flood-venv
2. 升级 pip
3. 安装 setuptools<81
4. 安装根目录 requirements.txt
5. 安装 frontend 依赖
6. 安装 runtime 依赖
```

执行：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app
.\scripts\windows\setup_windows.bat
```

脚本成功后应出现：

```text
Setup completed.
Next:
1. Fill in "...\.env" with your API keys and service account path.
2. frontend\.env.local will be generated from the root .env.
3. Run "scripts\windows\start_windows.bat" to start all services.
```

### 5.2 手工方式：Python 依赖

如果脚本失败，可以手工执行以下步骤：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app

python -m venv flood-venv
.\flood-venv\Scripts\activate

python -m pip install --upgrade pip
python -m pip install "setuptools<81"
python -m pip install -r requirements.txt
```

本机虚拟环境验证结果：

```text
Python 3.12.10
pip 26.0.1
```

关键 Python 包版本参考：

| 包 | 本机安装版本 | 作用 |
|---|---:|---|
| Flask | 1.1.4 | 历史接口和兼容逻辑 |
| fastapi | 0.115.14 | Agent 后端服务 |
| uvicorn | 0.41.0 | FastAPI ASGI 服务 |
| langgraph | 1.0.10 | Agent 图执行框架 |
| langchain-openai | 1.1.11 | LangChain OpenAI 接入 |
| copilotkit | 0.1.78 | Python 侧 CopilotKit/AG-UI 集成 |
| tavily-python | 0.7.23 | Tavily 搜索 |
| earthengine-api | 1.7.22 | Google Earth Engine |
| openai | 2.32.0 | Python OpenAI SDK |
| google-api-python-client | 1.12.8 | Google API 调用 |
| google-auth | 1.32.1 | Google 鉴权 |
| reportlab | 4.0.6 | PDF 报告生成 |

注意：Python 依赖现在以根目录 `requirements.txt` 为唯一维护入口。`agent\requirements.txt` 仅保留为兼容转发文件，内容是 `-r ../requirements.txt`，避免旧命令立即失效。

### 5.3 手工方式：Node 依赖

前端依赖：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\frontend
npm install
```

Runtime 依赖：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\runtime
npm install
```

如果追求严格复现 `package-lock.json`，可以把 `npm install` 换成：

```powershell
npm ci
```

本项目两份 lockfile 都是 `lockfileVersion=3`，与 npm 10.9.2 匹配。

前端关键依赖实际锁定版本：

| 包 | lockfile 版本 |
|---|---:|
| react | 18.3.1 |
| react-dom | 18.3.1 |
| react-scripts | 5.0.1 |
| @copilotkit/react-core | 1.53.0 |
| @copilotkit/react-ui | 1.53.0 |
| mapbox-gl | 2.15.0 |
| @mapbox/mapbox-gl-draw | 1.5.1 |
| axios | 1.13.4 |
| lucide-react | 0.468.0 |
| http-proxy-middleware | 2.0.9 |
| react-markdown | 9.1.0 |
| shpjs | 6.2.0 |

Runtime 关键依赖实际锁定版本：

| 包 | lockfile 版本 |
|---|---:|
| @copilotkit/runtime | 1.53.0 |
| express | 4.22.1 |
| cors | 2.8.6 |
| dotenv | 16.6.1 |
| openai | 4.104.0 |
| tsx | 4.21.0 |
| typescript | 5.9.3 |
| @types/node | 22.19.7 |
| @types/express | 4.17.25 |
| @types/cors | 2.8.19 |

## 6. 配置环境变量

根目录 `.env` 是唯一推荐配置入口。初始化脚本会在缺失时从 `.env.example` 复制生成：

```powershell
copy .env.example .env
```

必须填写：

```env
OPENAI_API_KEY=你的 OpenAI API Key
TAVILY_API_KEY=你的 Tavily API Key
GOOGLE_APPLICATION_CREDENTIALS=你的 GEE 服务账号 json 路径
GEE_PROJECT_ID=你的 Google Cloud Project ID
REACT_APP_MAPBOX_ACCESS_KEY=你的 Mapbox Token
```

推荐保留的本地默认端口：

```env
SATGPT_PUBLIC_HOST=localhost

AGENT_HOST=0.0.0.0
AGENT_PORT=8000
AGENT_DEBUG=True

RUNTIME_HOST=0.0.0.0
RUNTIME_PORT=5000

FRONTEND_HOST=0.0.0.0
FRONTEND_PORT=3000
```

代理配置按需填写：

```env
HTTP_PROXY=http://127.0.0.1:7890
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1
no_proxy=localhost,127.0.0.1,::1
```

配置完成后同步前端公开变量：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\sync_frontend_env.ps1 -RootDir .
```

脚本会生成或更新：

```text
frontend\.env.local
```

## 7. 启动服务

### 7.1 推荐方式：一键启动

```powershell
Set-Location E:\GMS\Flood\SatGPT-app
.\scripts\windows\start_windows.bat
```

或：

```powershell
.\start_all.bat
```

成功后会打开 3 个命令行窗口：

```text
FastAPI Agent      http://localhost:8000
CopilotKit Runtime http://localhost:5000
React Frontend     http://localhost:3000
```

浏览器访问：

```text
http://localhost:3000
```

### 7.2 手工启动

终端 1：FastAPI Agent

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\agent
..\flood-venv\Scripts\python.exe server.py
```

终端 2：CopilotKit Runtime

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\runtime
npm start
```

终端 3：React Frontend

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\frontend
npm start
```

## 8. 验证部署

### 8.1 版本验证

```powershell
python --version
node --version
npm --version
.\flood-venv\Scripts\python.exe -m pip --version
```

期望：

```text
Python 3.12.10
v22.16.0
10.9.2
pip 26.0.1
```

### 8.2 目录验证

```powershell
dir flood-venv\Scripts\python.exe
dir frontend\node_modules\react-scripts\bin\react-scripts.js
dir runtime\node_modules\.bin\tsx.cmd
dir .env
dir frontend\.env.local
```

### 8.3 服务验证

Runtime 健康检查：

```powershell
curl.exe http://localhost:5000/health
```

期望返回类似：

```json
{
  "status": "ok",
  "service": "copilotkit-runtime",
  "agentUrl": "http://localhost:8000"
}
```

前端访问：

```text
http://localhost:3000
```

Agent 模式链路：

```text
浏览器 -> React 前端 :3000 -> CopilotKit Runtime :5000 -> FastAPI Agent :8000
```

旧版地图/分析接口链路：

```text
浏览器 -> React 前端 :3000 -> React dev proxy -> FastAPI Agent :8000
```

## 9. 常见问题排查

### 9.1 Python 或 npm 找不到

现象：

```text
[ERROR] Python not found in PATH.
[ERROR] npm not found in PATH.
```

处理：

```powershell
where.exe python
where.exe npm
```

如果没有输出，重新安装 Python/Node.js，并确认已加入 PATH。安装后必须重新打开 PowerShell。

### 9.2 端口被占用

默认端口：

| 服务 | 端口 |
|---|---:|
| React Frontend | 3000 |
| CopilotKit Runtime | 5000 |
| FastAPI Agent | 8000 |

检查端口：

```powershell
netstat -ano | findstr ":3000"
netstat -ano | findstr ":5000"
netstat -ano | findstr ":8000"
```

结束占用进程：

```powershell
taskkill /PID <PID> /F
```

或者修改 `.env`：

```env
FRONTEND_PORT=3001
RUNTIME_PORT=5001
AGENT_PORT=8001
```

修改后重新运行：

```powershell
.\scripts\windows\start_windows.bat
```

### 9.3 前端启动但 Agent 聊天失败

优先检查三点：

```powershell
curl.exe http://localhost:5000/health
curl.exe http://localhost:8000/docs
type frontend\.env.local
```

关键逻辑：

```text
React /copilotkit
    -> frontend\src\setupProxy.js
    -> CopilotKit Runtime
    -> runtime\server.ts
    -> FastAPI Agent /agent
```

如果 Runtime 的 `agentUrl` 仍指向旧端口，检查根目录 `.env` 中的：

```env
SATGPT_PUBLIC_HOST=
AGENT_PORT=
AGENT_URL=
```

### 9.4 GEE 鉴权失败

检查：

```powershell
type .env
Test-Path "GOOGLE_APPLICATION_CREDENTIALS 对应的 json 路径"
```

`.env` 中建议使用绝对路径，或使用相对项目根目录的路径：

```env
GOOGLE_APPLICATION_CREDENTIALS=.\satgpt-xxxx.json
GEE_PROJECT_ID=your-gcp-project
```

`agent\project_env.py` 会把相对路径解析为项目根目录下的绝对路径。

### 9.5 npm 安装慢或失败

先确认 registry：

```powershell
npm config get registry
```

国内网络建议：

```powershell
npm config set registry https://registry.npmmirror.com/
```

清理后重装：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\frontend
npm ci

Set-Location E:\GMS\Flood\SatGPT-app\runtime
npm ci
```

### 9.6 PowerShell 执行策略阻止脚本

现象：

```text
running scripts is disabled on this system
```

临时允许当前命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\sync_frontend_env.ps1 -RootDir .
```

如果是 `.bat` 脚本，一般不受 PowerShell 执行策略影响。

## 10. 生产部署建议

当前仓库更偏本地开发/演示部署。如果要上服务器，建议按以下方向改造：

1. 前端执行生产构建：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\frontend
npm run build
```

2. Runtime 执行 TypeScript 构建：

```powershell
Set-Location E:\GMS\Flood\SatGPT-app\runtime
npm run build
npm run start:prod
```

3. FastAPI Agent 使用进程管理器托管，例如 Windows 服务、PM2、NSSM 或服务器上的 systemd。

4. `.env` 中不要提交任何密钥，尤其是：

```text
OPENAI_API_KEY
TAVILY_API_KEY
GOOGLE_APPLICATION_CREDENTIALS
GEE_PROJECT_ID
REACT_APP_MAPBOX_ACCESS_KEY
```

5. 如需公网访问，应显式配置：

```env
SATGPT_PUBLIC_HOST=你的服务器域名或 IP
SATGPT_CORS_ORIGINS=http://你的域名:3000
```

## 11. 最小可执行部署清单

如果只想用最短路径跑起来，按这个清单执行：

```powershell
# 1. 安装 Python 3.12.10 和 Node.js 22.16.0 后，重新打开 PowerShell
python --version
node --version
npm --version

# 2. 进入项目
Set-Location E:\GMS\Flood\SatGPT-app

# 3. 初始化
.\scripts\windows\setup_windows.bat

# 4. 填写 .env
notepad .env

# 5. 启动
.\scripts\windows\start_windows.bat

# 6. 访问
# http://localhost:3000
```

这个流程的本质像 FPS 游戏开黑前的设备检查：先锁定硬件和驱动版本，再进房间。Python/Node 版本就是“显卡驱动”，`.env` 是“账号和服务器配置”，三个端口服务是“语音、游戏、匹配服务”。任何一个没起来，前端界面可能还在，但完整链路一定会断。
