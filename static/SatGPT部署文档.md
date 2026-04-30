# SatGPT Windows 本地部署文档

# 大纲
## 安装python

## 安装nodejs

## 从github上下载项目代码

## 启动环境配置脚本

## 启动项目




适用系统：Windows 10/11 x64

当前项目采用三服务结构：

```text
React 前端 :3000
  |-- /api、/health、/agent --> FastAPI Agent :8000
  `-- /copilotkit ----------> CopilotKit Runtime :5000 --> FastAPI Agent :8000/agent
```

## 版本要求

| 软件 | 要求版本 |
| --- | --- |
| Python | 3.12.10 x64 |
| Node.js | 22.16.0 x64 |
| npm | Node.js 22.16.0 自带版本 |

验证：

```powershell
py -3.12 --version
node --version
npm --version
```

期望：

```text
Python 3.12.10
v22.16.0
```

## 初始化

在仓库根目录执行：

```powershell
.\scripts\windows\setup_windows.bat
```

脚本会完成：

```text
1. 检查 Python 3.12.10
2. 检查 Node.js 22.16.0 和 npm
3. 创建或复用 flood-venv
4. 升级 pip 并安装 setuptools<81
5. 安装 FastAPI 后端依赖
6. 安装 frontend 和 runtime 的 npm 依赖
7. 创建 .env 并同步 frontend\.env.local
```

## 环境变量

初始化后编辑仓库根目录 `.env`：

```env
OPENAI_API_KEY=你的 OpenAI API Key
TAVILY_API_KEY=你的 Tavily API Key
GOOGLE_APPLICATION_CREDENTIALS=你的 GEE 服务账号 json 路径
GEE_PROJECT_ID=你的 Google Cloud Project ID
REACT_APP_MAPBOX_ACCESS_KEY=你的 Mapbox Token
```

默认端口：

```env
AGENT_PORT=8000
RUNTIME_PORT=5000
FRONTEND_PORT=3000
```

## 启动

```powershell
.\start_all.bat
```

成功后访问：

```text
http://localhost:3000
```

## 验证

```powershell
curl.exe http://localhost:8000/health
curl.exe http://localhost:8000/api/gee-status
curl.exe http://localhost:5000/health
```

如果 `api/gee-status` 返回未初始化，检查 `.env` 中的 `GOOGLE_APPLICATION_CREDENTIALS` 和 `GEE_PROJECT_ID`。

## 常见问题

端口占用：根据启动脚本提示关闭占用进程，或修改 `.env` 中的 `AGENT_PORT`、`RUNTIME_PORT`、`FRONTEND_PORT`。

Python/Node 找不到：确认 `py -3.12`、`node`、`npm` 在当前终端可用。用户级安装也可以使用，但必须出现在当前用户的 PATH 中。

前端变量未更新：修改根目录 `.env` 后，重新执行启动脚本；脚本会同步 `frontend\.env.local`。

