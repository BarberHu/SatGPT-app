# Deployment scripts

唯一模板和填写入口是根目录 `.env.example` / `.env`；优先级为进程环境 > 根目录文件 > 默认值。

- Windows：`scripts\windows\satgpt.bat setup/dev/build/prod/deploy`。
- 校验：`harness\.venv\Scripts\python.exe satgpt_config.py check`（不代表认证已通过）。
- Docker：见 [PRODUCTION.md](../PRODUCTION.md)，从根目录保留 `--project-directory . --env-file .env` 参数运行 Compose。

Windows 两个 API 通过共享启动器读取配置端口；不再自动发现其他项目配置。修改地图配置后重新构建生产前端；其余重启范围见主 README。
