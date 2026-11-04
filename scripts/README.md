# Deployment scripts

唯一模板和填写入口是根目录 `.env.example` / `.env`；优先级为进程环境 > 根目录文件 > 默认值。

- Windows：`scripts\windows\satgpt.bat setup/dev/build/prod/deploy`。
- 校验：`harness\.venv\Scripts\python.exe satgpt_config.py check`（不代表认证已通过）。
- Docker：见 [PRODUCTION.md](../PRODUCTION.md)，从根目录保留 `--project-directory . --env-file .env` 参数运行 Compose。

Windows 安装只使用 `harness/.venv/` 和唯一的根 `requirements.txt`（含已验证的直接及间接依赖版本）；开发与生产均只启动一个前端和一个统一后端。后端通过 `satgpt_config.py backend` 读取 `AGENT_PORT`，强制单 worker；旧 `HARNESS_PORT`/`HARNESS_HOST` 已忽略。不再自动发现其他项目配置。修改地图配置后重新构建生产前端；其余重启范围见主 README。

旧 `basic`/`harness` 子命令均转向统一后端，勿同时启动。旧 `basic-venv/` 不会删除；验证迁移后可自行清理，保留 `harness/.venv/` 与会话目录。健康、限制和回归命令详见 [PRODUCTION.md](../PRODUCTION.md)。

Python 依赖统一在根目录执行 `harness\.venv\Scripts\python.exe -m pip install -r requirements.txt`；模块内旧依赖清单已移除。后端镜像只维护根目录 `Dockerfile`。

后端只运行 `satgpt_backend:app`。Basic 和 Harness 的 `server.py` 均为路由模块，不再提供模块级 `app` 或独立启动行为；直接模块启动方式应改用 `satgpt_config.py backend`。两边生命周期继续由统一入口显式进入和退出。
