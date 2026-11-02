# Docker deployment

从根目录运行：

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
```

保留 `--project-directory .` 以保证相对凭据/构建路径从根目录解析。Shell 配置优先；只有前端配置端口发布到宿主机回环地址，后端留在容器网络。详见 [PRODUCTION.md](../../PRODUCTION.md)。
