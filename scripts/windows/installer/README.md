# SatGPT Windows 离线打包与图形安装向导

面向普通 Windows 用户的零环境一键安装方案：开发者提前构建离线包，用户双击 `SatGPT-Setup.exe` 即可查看分步进度完成安装，只需通过系统文件管理器导入 `.env`（或临时跳过）。

## 目录文件说明

- `build_bundle.ps1`：开发者离线打包脚本，产出目录为 `dist/SatGPT-Windows-Offline/`（已被 `.gitignore` 忽略）。
- `SatGPTSetup.cs`：原生 Windows 4 步图形安装向导源码（使用 Windows 自带 `.NET Framework 4 csc.exe` 编译为 `SatGPT-Setup.exe`，无需用户预装 Python/Node/.NET）。
- `SatGPTLauncher.cs`：安装完成后放置在目标目录的轻量桌面启停器源码（编译为 `SatGPT-Launcher.exe`），使用目标目录内自带的便携 Python 3.12 与 `node.exe` 管理服务启停与健康灯。

## 开发者构建离线分发包

在仓库根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\installer\build_bundle.ps1
```

常用参数：
- `-SkipFrontendBuild`：复用已有的 `frontend/build/`，跳过前端重新编译。
- `-RefreshWheels`：强制重新下载全量 Python 依赖 wheels（默认自动复用 `dist/.installer-cache/` 中与当前 `requirements.txt` 哈希匹配的缓存）。

## 小白用户安装步骤

1. 将整个 `SatGPT-Windows-Offline` 文件夹（或压缩包解压后）拷贝到目标 Windows 电脑。
2. 双击 `SatGPT-Setup.exe`：
   - **步骤 1**：选择安装目录（默认 `C:\SatGPT`）。
   - **步骤 2**：自动执行 4 个固定步骤，每步各自独立 0% → 100% 进度条：
     1. 复制 SatGPT 应用文件
     2. 部署内置 Python 3.12 环境
     3. 离线安装 Python 依赖（wheels）
     4. 部署内置 Node.js 与前端运行文件
   - **步骤 3**：通过系统文件管理器分别导入 2 个配置文件（`.env` 环境配置 + GEE 服务账号密钥 JSON，支持自动对齐 `.env` 指定文件名并在同目录存在时自动顺带导入），或点击「临时跳过此步骤」。
   - **步骤 4**：完成安装，可选创建桌面快捷方式并打开 `SatGPT-Launcher.exe`（启动器内同样支持补导 `.env` 与密钥 JSON 并一键启停服务）。
