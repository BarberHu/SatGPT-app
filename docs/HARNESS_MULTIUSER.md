# Harness 匿名多用户

## 实施基线

GitHub 的 `pro2.0` 已拉取。本次使用 `14fd5d951d2c1f79f7cf5fe7bbe4d607b53d203b` 作为基线，实施目录是 `E:GMSFloodSatGPT-app-native-multiuser`，分支为 `wy/shared-harness-20261119`。独立工作区修改前为空。未提交、推送或部署本次实现。

原工作区 `E:GMSFloodSatGPT-app` 在 `wy/agent-multiuser-20261119`，已有实现位于 `ffb4a060`。开始时其已跟踪文件无差异，共有 55 个未跟踪文件，集中在 `.codex-tmp/`、`.workbuddy/`、`_doc_imgs/`、根目录的文本和探查脚本，以及 `docs/` 下的本地工作文档。此次未改动原工作区及其服务。

## 运行关系

~~~text
浏览器签名 Cookie
  └─ SatGPT 校验 owner → conversation → task，并检查并发名额
        └─ 一个 DeepSeek Harness SDK runtime
              ├─ 原生 Session / Agent A ─┐
              ├─ 原生 Session / Agent B ─┼─ 共用固定大小的 GEE worker 池
              └─ 原生 Session / Agent C ─┘
                    └─ 原生 tool/result + 实时展示帧 → 当前任务的 SSE 和历史
~~~

- SDK 的公开 API 负责初始化、创建和恢复原生会话、执行与订阅。模型上下文、循环与会话日志由 Harness 管理。
- Harness 插件通过 `ctx.agents.get()` 和原生 `Agent.cancel()` 停止目标会话，通过 `exec.agent.session.id` 定位工具来源。`output.presentationMeta` 进入持久化的 `tool/result.data.meta`。取消端点由 SatGPT 的本机插件提供，使用独立认证令牌。
- SatGPT 使用 SQLite 保存归属、页面消息和接纳回执，用任务绑定向插件交付不可变的地理范围及产物目录。SSE 的等待使用异步通知。掉线后的页面可按游标补读，终态以服务端保存的快照为准。

官方参考为固定标签 `dsh-v0.2.1-rc.2`。已核对安装包的 Python API 和 client 文件与该标签一致。 [Python SDK](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-rc.2/python/sdk) · [Agent 扩展接口](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/agent/README.md) · [工具定义](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.2/packages/core/tools/src/index.ts)

## 关键代码对照

原 `HarnessAgent.cancel()` 关闭整个 SDK 连接，切换会话也会重建实例。现在 `SharedRuntime` 复用 SDK，取消需匹配正在执行的会话和轮次，由插件调用原生取消。收到取消回执后，业务任务继续占用名额，直到 `Session.run()` 返回且绑定完成清理。

~~~diff
- self._agent.__exit__(None, None, None)
+ self.runtime.control('/cancel', {'session_id': task.native_id, 'run_id': task.run_id})
+ // 插件验证绑定后调用 agent.cancel({ kind: 'user' })
~~~

原图层来自同一 `gee-tool-events.jsonl` 的新文件偏移。现在使用原生工具结果内的任务、轮次和调用标识，图层重载复用保存的生成配方和同一 worker 池。

~~~diff
- events = self._tool_events(offset)
+ output = self._project(task, result.events, snapshot)
~~~

浏览器在向私有 API 发请求之前完成 Cookie 初始化。前端的会话选择放在每个标签页的 `sessionStorage`。初始化在安全上下文使用 Web Locks，其他情况下用 IndexedDB 事务协调同源标签页。

## 对照附件的实现范围

| 附件章节 | 实现与边界 |
| --- | --- |
| 一、二 | 独立工作区和共享 runtime。保留先前分支及原来的状态和配置。 |
| 三 | 固定 SDK/runtime `0.2.1rc2`。先实测原生并发、通知分流、定向取消、工具身份和元数据持久化，再接入应用。 |
| 四 | 签名、带有效期的 HttpOnly Cookie。服务端检查每条私有路由的资源归属，缺失与越权返回 404，跨源写入返回 403。业务图层缓存的键包含服务端 owner。 |
| 五、六 | 每会话注册一个原生 Session。重启按需原生恢复，异常明确报错。旧共享历史留存为未分配数据。每轮任务绑定含 owner、会话、轮次、范围和产物路径。删除会话时业务记录置为删除状态，保留底层文件。 |
| 七、八 | 图层和预览从原生事件投影，按轮次和工具调用去重。瞬时流实时展示，终态由已提交事件校对。SSE 支持重连和多观察者。 |
| 九 | GEE worker 池默认 16 槽，延迟启动，等待容量独立配置，默认 128。取消只回收目标调用的工作进程。图层重载走同一池。 |
| 十、十一 | 最新排队方案取消全站与单浏览器的固定提交上限。每会话只接受一个未完成任务，重复提交返回 409，幂等重试返回原任务。执行槽默认 128 个，单任务执行期限默认 7200 秒，从领取时计时。 |
| 十二 | 默认 128 个原生会话驻留上限，达到上限时等待业务任务及重载清空后轮换。限制原生工具列表并在执行时再次检查绑定。共享进程仍共享系统资源和故障域。现有 GEE Python 执行约束属于应用级隔离。 |
| 十三 | 保留页面布局、地图、AOI、图表及历史交互。Basic 仅修改业务图层归属。 |
| 十四、十五 | 分开记录自动化、原生运行时、Chromium、外部服务和容器结果。 |

主要修改位于 `harness/app/controller.py`、`session_store.py`、`shared_runtime.py`、`identity.py`、`server.py`、GEE 和流式插件、前端会话入口、Basic 业务图层路由以及配置和对应测试。可用 `git status --short` 查看完整文件清单。

## 启动、配置与恢复

在独立工作区按 `README.zh-CN.md` 设置现有服务凭据和前端配置。端口使用未占用的值。验证使用临时服务和临时状态，无需切换原工作区运行服务。

~~~powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat dev
~~~

| 配置 | 默认值 |
| --- | --- |
| `AGENT_WORKERS` | 1 |
| `SATGPT_AGENT_TASKS` | 128 个执行槽，可设为 1–128 |
| `SATGPT_GEE_WORKERS` | 16，可设为 1–32 |
| `SATGPT_GEE_QUEUE_LIMIT` | 全局等待 128，可设为 1–65535。单身份上限按全局等待位的一半向上取整 |
| `SATGPT_HARNESS_TIMING_LOG` | 可选，填写 Harness 可写的绝对路径以追加诊断 JSONL。包含 GEE 入队、领取、返回及拒绝，还有模型重试和重试启动的时间。建议在诊断结束后关闭以控制文件大小 |
| `SATGPT_AGENT_RESIDENT_SESSIONS` | 128，须至少等于执行槽数量 |
| `SATGPT_AGENT_DEADLINE_SECONDS` | 7200 秒，可设为 1–7200，从执行器领取任务起计时 |

128 个执行槽表示调度配置。已验证默认 128 通过启动校验，129 被拒绝。模拟 runtime 中 128 个任务重叠执行，第 129 个任务排队后完成，同一聊天重复提交返回 409。真实模型与 GEE 的实测并发见下方验证记录。显式设置 `.env` 或进程环境变量会覆盖默认值。
| `SATGPT_GEOCODING_URL` | 默认留空。填写自托管或经授权的 Nominatim 兼容搜索端点后，DSH 可调用 `geocode_place`，独立于 OSM Overpass 开关 |

`geocode_place` 将用户明确提到的地名和可选国家、语言过滤条件发送给配置的服务。候选包含地名、行政区、WGS84 位置、可用的包围盒及 OSM 归属。单个 worker 处理请求并缓存成功和无匹配结果，工具结果可随会话保存。配置的服务需允许这些用途。

如选择 OSMF 公共服务，在部署环境中将 `SATGPT_GEOCODING_URL` 设置为 `https://nominatim.openstreetmap.org/search`。公共服务仅用于用户明确请求的公开地名查询。避免发送私人地址或保密信息，也不要用于自动补全、批量或系统性查询。缓存未命中时，共用同一 `harness/state/nominatim-rate.sqlite3` 的 DSH 进程串行访问公共服务。每次取得锁后等待至少 1.1 秒，请求结束后释放锁。使用独立状态卷的多实例或多主机部署，需要先统一公共请求出口，再启用这个端点。 [Nominatim 使用政策](https://operations.osmfoundation.org/policies/nominatim/)

地理编码可用于定位和澄清同名地点。遇到地名与已选区域冲突时，Agent 应先请用户确认范围，再执行分析。包围盒用于定位，精确分析使用确认后的研究区几何。

128 个执行槽表示调度配置。已验证默认 128 通过启动校验，129 被拒绝。模拟 runtime 中 128 个任务重叠执行，第 129 个任务排队后完成，同一聊天重复提交返回 409。真实模型与 GEE 的实测并发见下方验证记录。显式设置 `.env` 或进程环境变量会覆盖默认值。

HTTPS 网关设置 `SATGPT_PUBLIC_ORIGIN` 为浏览器实际访问的 origin，启用 `SATGPT_COOKIE_SECURE=true`。网关应保留浏览器 Host，后端的 Uvicorn 转发头信任范围限定为实际代理。调试时使用同源前端端口。API 脚本先访问 `/api/harness/session`，在后续请求带回 Cookie，同源写请求附带 Origin，提交附带 conversation_id 和 request_id。

个人任务在页面点停止。服务维护时停止前端与后端进程，再用同一状态目录重启。默认状态在 `harness/state/multiuser/` 下，需要一起保留 SQLite、`identity.key`、原生 `dsh-home/` 和 `artifacts/`。如使用 Compose，保留 `harness_state` 卷。上次排队或仍活动的回执恢复为 interrupted，用户自行决定是否重新提交。

收到 runtime 不可用时查看 `/readyz`，再对整个后端做进程级恢复。该操作影响进程内全部活动任务。清理不能确认的任务持续占用自己的名额，进程重启后可查看其结果状态。

Agent 的 OSM 查询、Overpass 客户端和快照读取位于 harness/app，由 DSH 工具调用。Basic 的道路和建筑预览使用 Mapbox Streets v8 矢量瓦片。

## SQLite 排队

提交成功返回 `202` 和 `queued`。任务记录与用户消息在同一事务写入，调度器按提交顺序领取。启动、运行、停止和清理占用执行槽。排队任务可以用原任务 ID 查询和接收 SSE，关闭页面后刷新仍可恢复进度。

同一聊天的排队任务也占用该聊天的唯一名额。重复提交返回 `409`，原请求的幂等重试返回原回执。取消排队任务直接进入 `cancelled`，无需打开原生会话。原有的 `SATGPT_AGENT_TASKS_PER_OWNER` 配置已取消，旧环境中的同名变量不再参与校验或调度。

每个被领取的任务回执记录 `created_at`、`dispatched_at` 和 `queue_wait_ms`。`started_at` 仍表示任务进入运行阶段。SQLite 新增队列索引和同聊天未完成任务的唯一索引，已有任务表和终态记录可以继续使用。

排队改造前后对应关系如下。

~~~diff
- if len(self.active) >= self.limit:
-     raise AdmissionError('global_capacity', 'Too many active analyses. Try again shortly.')
+ # 提交在 SQLite 写入 queued 回执。
+ # _dispatch_queued() 仅在有空闲执行槽时从 SQLite 领取任务。
~~~

### 排队改造验证

| 验证 | 结果 |
| --- | --- |
| 自动化与构建 | Python 68 项及 13 个子用例、Node 14 项、前端 130 项通过，前端生产构建成功。 |
| Chromium | 两个 Cookie 隔离身份、同身份双标签页验证通过。执行槽满时能看到排队，刷新恢复排队状态，取消排队任务没有调用模型。释放空位后另一身份的任务自动开始，并生成真实 GEE 图层和私有缩略图。该次页面验证使用受控模型端点。 |
| Windows 真实服务 | 单任务生成真实 GEE 图层，预览本人 200、另一身份 404，重载 200。随后以 2 个执行槽提交 4 个任务，4/4 完成。实测模型请求和 GEE 工具调用最多各重叠 2 路，排队时延为 4 ms、5 ms、14.238 s、14.877 s。临时验证进程沿用直连，现有服务配置无改动。 |
| Linux 容器 | 后端镜像构建成功。受控模型验证双原生会话重叠、定向取消及幂等。 |

## 初版多用户验证

| 验证 | 结果 |
| --- | --- |
| 自动化回归 | Python 67 项及 13 个子用例，Node 14 项，前端 130 项全部通过。 |
| 前端生产构建 | 构建成功。Vite 报告两个压缩前超过 1000 kB 的分块。 |
| 固定版本原生能力 | 控制端点确认两个原生会话请求重叠。取消 A 后 B 正常执行。工具读到 B 的原生 ID，展示元数据写入 SDK 原生日志，重启后成功恢复该会话。 |
| 真实模型与 GEE，Windows | 单任务、双并发、四并发共 7 个成功。四并发轮模型区间重叠最多 4 路，GEE 调用区间重叠最多 3 路。单任务生成真实层与缩略图，同 Cookie 读预览 200、另一 Cookie 404，重载 200。单次测量进程树 RSS 峰值约 504 MiB。 |
| 实际 Chromium | 两个隔离上下文和同上下文两个标签页。禁用 Web Locks 后并发初始化仍共享同一身份。切换、刷新、SSE 重新订阅、跨标签停止、真实 GEE 图层缩略图和归属校验均通过。模型由受控端点驱动。 |
| Linux 容器，受控模型 | 4 GiB 容器内构建并验证双会话重叠、定向取消及幂等。镜像为非 root 用户创建可写主目录，供固定版本原生运行时展开缓存。 |
| Linux 容器，外部服务 | 一条真实模型 → GEE 图层任务完成，预览归属校验与重载通过。容器 cgroup `memory.peak` 约 697 MiB，含缓存。 |

真实验证沿用原有配置的 AIHubMix 模型通道。首次尝试使用既有代理时收到 `TRANSPORT` 连接错误。随后仅在临时验证进程移除代理变量并直连，原配置文件与现有服务保持原样。测量描述的是本次工作负载，容量配置可调整，仍需按生产流量做长时间稳定性验证。

回归命令如下。Python 环境需另外安装 pytest。

~~~powershell
.\harness\.venv\Scripts\python.exe -m pytest -q harness/tests scripts/tests
node --test (Get-ChildItem harness/tests/*.test.mjs).FullName
npm --prefix frontend test -- --maxWorkers=2
npm --prefix frontend run build
~~~

验证图层重载时，在临时端口运行 `python -m harness.tests.region_page_server`，再用同一端口运行 `python -m harness.tests.live_analysis_region`。检查会用同一个浏览器身份生成和重载测试图层，并校验保存的配方、历史和瓦片。

浏览器 Cookie 提供应用资源归属。Earth Engine 直接瓦片地址仍按该上游服务的访问规则处理。GEE 工具保留 Python 解释器执行能力，操作系统级隔离、长期磁盘配额以及历史数据迁移不属于本次工作。
