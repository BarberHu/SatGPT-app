# 从 GitHub 部署 SatGPT

本分支提供可运行源码、依赖锁文件和部署脚本，不包含测试、实验、运行记录或密钥。支持拉取 GitHub 源码后手动部署；目前没有 GitHub Actions 自动发布流程。Windows 本地部署见 [README.md](README.md)。

## Docker / Linux

需要 Git、Docker Engine 和 Docker Compose v2 或以上。在宿主机执行：

```bash
git clone --branch pro2.0 --single-branch https://github.com/BarberHu/SatGPT-app.git
cd SatGPT-app
cp .env.example .env
```

按 README 填写 `.env` 中的 GEE 项目、模型密钥、Mapbox token。将有权限的 GEE service account JSON 保存为根目录 `.private-key.json`；Compose 固定挂载此文件，文件缺失时会直接报错。不要把 `.env` 或密钥提交到 Git。

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml up -d --build
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml ps
```

打开 http://127.0.0.1:3000/。部署包含三个服务：

```text
浏览器 → frontend :3000 → Basic API :8000
                       → Harness API :8001
```

后端端口只在容器网络内开放；前端默认仅绑定宿主机回环地址。Basic 和 Agent 共用服务账号，模型配置独立。GEE 与模型服务均需可达。

```bash
curl --fail http://127.0.0.1:3000/readyz
curl --fail http://127.0.0.1:3000/health
curl --fail http://127.0.0.1:3000/api/harness/conversations
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml logs --tail 100
```

`/readyz` 表示前端网关就绪，`/health` 为 Basic API 健康检查；会话接口用于检查 Harness API。健康检查不替代实际模型和 GEE 调用验证。

## 更新、停止与数据

```bash
git pull --ff-only origin pro2.0
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml up -d --build
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.harness.yml down
```

Agent 会话、任务和预览保存在命名卷 `satgpt_harness_state`，升级前应备份；普通 `down` 保留该卷，不要使用 `down -v`。非 Docker 部署的数据在 `harness/state/`。Basic 服务的会话级内存缓存重启后会清空。

Mapbox 配置在前端构建时写入；修改 token 或底图后需要重新构建前端。模型和 GEE 密钥仅在后端运行时加载，不写入镜像或浏览器包。

## 对外提供服务

当前适合可信用户使用。对外部署应在前端网关前增加 HTTPS、身份认证及访问控制，并增加模型/GEE 配额和代码执行隔离。多副本部署还需要共享会话存储。不要直接向公网开放 8000/8001。
