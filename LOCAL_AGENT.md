# 本地 Agent 与 Google OAuth（实验分支）

本模式由用户电脑同时提供网页、API、Agent 与 GEE worker。在线站点可以提供产品入口和静态资源下载；本轮没有部署站点、制作安装包或实现自动更新。

## 启动

在本实验工作树中使用已有隔离 Python 环境，先构建前端：

```powershell
cd D:\workspace\SatGPT-multiHazard\.worktrees\gee-personal-upload\frontend
npm run build
cd ..
& .\harness\.venv\Scripts\python.exe .\start_local.py
```

程序只监听 `127.0.0.1`，默认页面为 `http://127.0.0.1:3313/?mode=agent`。端口已占用会启动失败，不会停止其他程序。可用 `--port 3314` 运行另一实例；浏览器 AOI 按 origin 隔离，换端口不会自动显示原端口的区域库。

默认数据目录为 `%LOCALAPPDATA%\SatGPT\experimental-gee-personal-upload`，不依赖源码目录。高级用途可通过 `SATGPT_LOCAL_DATA_DIR` 指定独立目录。不要指向原项目、原状态目录或另一正在使用的实例。

本地入口不读取仓库 `.env` 中的管理员、模型或 Web OAuth 配置。前端构建仍沿用现有公开地图配置；它是构建产物的公共参数，不能放入任何私密凭据。

打开 **Google / GEE → Local application**：

1. 应用维护者在 Google Cloud 创建 **Desktop app** OAuth 客户端，将下载的 JSON 通过界面导入本机。当前不接受 `web` 类型客户端。该文件用于识别应用，不能替代用户授权。
2. 选择模型服务，填写模型名称和自己的 API key，保存到本机。空白 key 仅在服务商不变时保留已存的 key。
3. 点击 Google 登录，在系统浏览器完成授权。首次申请身份与 GEE 读取权限；上传时重新申请完整权限集合。Desktop 客户端不使用 Web 的 `include_granted_scopes` 增量机制。
4. 登录后输入自己的 GEE 项目并验证；上传前填写自己有权限使用的 bucket，再授权上传。

OAuth 使用授权码、S256 PKCE、state、浏览器绑定、nonce/ID token 验证和本机回调。应用注册、测试用户/发布验证、API 启用、GEE 注册以及项目/bucket IAM 仍需在 Google Cloud 完成。程序不创建项目、bucket 或修改 IAM。

## 已有数据与导入

原有 `harness/state` 和原 `.env` 不修改、不删除。首次启动新数据目录时，可显式复制本实验的旧状态：

```powershell
& .\harness\.venv\Scripts\python.exe .\start_local.py --import-existing
```

先停止正在使用该旧状态的实验服务，避免文件在复制期间变化；不需要停止原项目。导入用 SQLite backup 复制数据库，修正上传暂存路径并检查数据库完整性，然后发布完整副本。已存在本地数据时拒绝覆盖。失败的 `import-*` 暂存目录保留供检查；不会成为活动数据。

旧 Web OAuth 刷新凭据不能移交给 Desktop 客户端。导入保留用户 ID、连接归属、项目/bucket、资产、上传记录、个人和系统历史，但清除副本中的登录会话并标记连接需重新授权；源数据库的加密凭据保持原样。用同一 Google 账号重新登录后读取个人记录，必要时显式恢复上传。

旧系统对话在 **Local application → Previous system history** 中只读浏览，不分配给首次登录用户。旧 system 图层不能使用当前用户身份重放，应重新发起分析。个人历史图层保留原 owner、连接、项目和资产检查。

AOI 的 IndexedDB、存储键、格式及历史范围快照不改。保持原来的协议、主机和端口可继续使用对应浏览器区域库；不同 origin 的数据使用已有 AOI 导出/导入操作转移。清除浏览器站点数据仍会影响其本地库，不是云端备份。

## 数据与身份边界

- 对话、SDK 会话、工作区、事件、日志、预览、数据库和上传暂存在用户本机应用数据目录。
- Google 令牌和模型配置通过 Windows 当前用户 DPAPI 保护。没有明文或 localStorage 凭据回退；本阶段仅支持 Windows。跨机器复制加密文件不保证可解密。
- Agent 只接受经过连接检查的用户 OAuth lease。没有服务账号、ADC 或公共数据分析的系统回退；模型 key 不传入 GEE worker。
- GEE 计算发生在 Google；GCS 暂存和 EE assets 属于用户选择的云资源。原文件留在本机不代表上传副本也只在本机。
- 问题、AOI/分析上下文及工具结果会直接发送到用户选择的云端模型。当前不提供本地模型执行。
- 本地模式不加载 Basic 服务账号后端，界面明确显示 Basic 云服务不可用；地图、AOI 和个人 Agent 工作流继续复用。
- 校验 Host、Origin、跨站请求、应用会话与 CSRF；不信任转发头。本地登录 Cookie 使用端口专属名称，不覆盖旧统一后端登录。数据目录加实例锁，同一目录不允许并发运行两个应用。本地运行仍是可信本机工具，不是供不可信用户执行 Python 的公网沙箱。

## 验证与待办

本轮必要验证和原项目对比记录在忽略目录 `outputs/local-agent-20261114/`。自动化中的 Google、模型和云上传替身不等于真实账号验证。

同步云端仓库前执行完整前端/Python/Harness/Node 回归、生产构建和桌面回归，并补齐：

- 真实 Desktop OAuth 同意/拒绝、部分授权、刷新、撤销、重启和切换账号；测试状态与发布状态的差异。
- 用户 GEE 项目/IAM、公共与私有 Image/Table/collection、原身份重放和模型真实分析。
- 真正的 GeoJSON/GeoTIFF 导入、GCS 费用与权限、NoData/波段、取消/断线/进程重启恢复和安全清理。
- 实际用户历史迁移、多浏览器 AOI 导出导入及同 origin 恢复。
- 并发窗口、资源限额、模型配置切换、长任务取消和 Windows 干净环境安装。
- 后续安装包、应用签名、更新、在线入口和公网页面连接本机服务另行设计。

本轮不提交、不推送、不发布。全量验证的触发条件是同步云端仓库。
