# Docker deployment

从根目录运行：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
```

保留 `--project-directory .` 以保证相对凭据/构建路径从根目录解析。Shell 配置优先；只有前端配置端口发布到宿主机回环地址，后端留在容器网络。详见 [PRODUCTION.md](../../PRODUCTION.md)。

Compose 现在仅有 `agent`（统一 Basic + Harness）和 `frontend` 两个服务，使用 `AGENT_PORT` 和 `FRONTEND_PORT`。保留旧 `harness_state` 卷。旧栈迁移先用相同项目名执行 `down --remove-orphans`，不要加 `-v`，再启动统一配置；详见生产文档。后端统一使用根目录 `Dockerfile`，直接构建使用 `docker build -f Dockerfile .`；旧模块镜像副本已移除。前端的 `frontend/Dockerfile` 仍负责独立的前端镜像。
