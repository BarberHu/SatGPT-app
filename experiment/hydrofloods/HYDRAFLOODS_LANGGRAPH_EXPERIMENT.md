# HYDRAFloods 作为 LangGraph 本地工具的最小实现

更新日期: 2026-04-11

## 1. 本轮目标

这轮实验不再把 HYDRAFloods 直接写进 LangGraph 节点里，而是按更稳定的工程方式重构为:

1. `HYDRAFloods` 继续做库层。
2. 在 `experiment/hydrofloods` 下新增本地工具适配层。
3. LangGraph 代理只做请求解析、工具选择和结果格式化。
4. 工具层输出结构化结果和地图工件，不把 `ee.Image` 暴露给 agent。

## 2. 当前目录结构

本轮实验涉及的关键文件:

1. `experiment/hydrofloods/ee_utils.py`
2. `experiment/hydrofloods/tool_adapters.py`
3. `experiment/hydrofloods/tool_library.py`
4. `experiment/hydrofloods/TOOL_LIBRARY.md`
5. `experiment/hydrofloods/token_utils.py`
6. `experiment/hydrofloods/hydrafloods_langgraph_agent.py`

职责分工:

1. `ee_utils.py`
   - 负责 GEE 初始化。
   - 只认规范变量 `GOOGLE_APPLICATION_CREDENTIALS` 和 `GEE_PROJECT_ID`。

2. `tool_adapters.py`
   - 负责把 HYDRAFloods 封装成任务级工具。
   - 返回结构化结果、tile URL、thumbnail URL、元数据、复现代码。

3. `tool_library.py`
   - 负责维护工具注册表。
   - 作为代码里的单一事实来源。
   - 提供给 LLM 的压缩 catalog 视图。

4. `TOOL_LIBRARY.md`
   - 负责人类可读的工具目录。
   - 用稳定格式记录每个工具的职责、输入、输出和适用边界。

5. `token_utils.py`
   - 负责统计一次完整问答流程中的 LLM token 使用量。
   - 默认关闭。
   - 开启后记录每次 LLM 调用的 prompt/completion/total tokens。

6. `hydrafloods_langgraph_agent.py`
   - 负责自然语言解析。
   - 负责选择工具。
   - 负责格式化输出。
   - 不再直接实现 HYDRAFloods 业务逻辑。
   - 当前采用“轻量 LLM 路由 + 本地工具执行”的混合模式。

## 3. 当前实现的本地工具

本轮暴露了 4 个任务级工具:

1. `describe_hydrafloods_tools`
2. `get_water_extent_tile`
3. `get_flood_extent_tile`
4. `estimate_flood_depth_tile`

这几个工具是面向任务的，不是面向底层 API 的。

也就是说，agent 看到的是:

1. 做水体提取
2. 做洪水范围提取
3. 做水深估算
4. 查看工具清单

而不是:

1. `apply_func`
2. `select`
3. `rename`
4. `clip`
5. `getMapId`
6. `getThumbURL`

这正是“旧 Python 库接入智能体”的推荐方式。

## 4. 为什么这样设计

这是当前更稳的智能体工程做法:

1. 保持库纯粹。
2. 单独做工具适配层。
3. 在工具层处理参数规范、展示工件、结构化输出。
4. 让 LangGraph 只编排工具，而不是直接操纵业务细节。

这样做的好处:

1. `HYDRAFloods` 可以继续作为独立库演进。
2. SatGPT / LangGraph 不需要知道 `ee.Image` 内部细节。
3. 工具接口更容易测试、复用、迁移。
4. 后续要接主项目时，只需要搬工具层，而不是拆散业务代码。

## 5. 这次实现的最佳实践点

### 5.1 库层和 agent 层解耦

本轮没有改 HYDRAFloods 源码，而是在外层新增 `tool_adapters.py`。

这是这类需求最重要的一条实践:

1. 旧库保留原职责。
2. 新能力通过 adapter 暴露。
3. 不把 agent 逻辑侵入库内部。

### 5.2 工具层只暴露任务级接口

工具层不是“把库里的函数都导出去”，而是只暴露少量高价值动作。

这轮最小集合就是:

1. 水体提取
2. 洪水提取
3. 水深估算
4. 工具说明

### 5.3 返回结构化结果而不是内部对象

工具返回的是:

1. `status`
2. `summary`
3. `inputs`
4. `artifacts`
5. `metadata`
6. `repro_code`

而不是直接把 `ee.Image`、`Dataset` 返回给 agent。

这能显著降低 agent 的上下文负担，也更利于前端和地图系统消费。

### 5.4 展示逻辑留在工具层

本轮不再只输出 `getThumbURL` 图片，而是补了在线地图工件:

1. `tile_url`
2. `thumbnail_url`

其中 `tile_url` 来自 `getMapId(...)[\"tile_fetcher\"].url_format`，更适合在线地图叠加。

### 5.5 LangGraph 只做编排

现在的图结构很薄:

1. `detect_environment`
2. `parse_request`
3. `select_tool`
4. `execute_tool`
5. `format_response`

也就是说，这一层已经更像“workflow orchestrator”，而不是把业务逻辑硬编码在节点里。

### 5.6 自然语言解析改为轻量 LLM 路由

上一版实验主要靠关键词做动作判定，泛化能力偏弱。

本轮改成了:

1. 先用本地规则抽取明显字段:
   - `bbox`
   - 日期
   - 数据集候选
   - 算法候选
2. 再调用一次短提示的 LLM，输出结构化 `QueryPlan`
3. 最后仍然由本地工具层执行真实任务

这意味着:

1. 模型只负责“理解请求和选工具”
2. 模型不参与 HYDRAFloods 业务计算
3. 结构化输出减少了解析歧义

### 5.7 工具知识从 agent 中抽成独立工具库

本轮又把工具知识从 agent 文件里抽出来，形成独立工具库:

1. `tool_library.py` 是代码单一事实来源。
2. `TOOL_LIBRARY.md` 是人类可读目录。
3. 路由 prompt 不再手写散落的工具说明，而是读取压缩 catalog。
4. 新增工具时，先改工具注册表，再改适配器实现，最后由 agent 自动读取。

这更接近成熟工具调用框架的方式:

1. 工具有稳定名字。
2. 工具有短描述。
3. 工具有适用条件。
4. 工具有明确输入输出。

### 5.8 省 token 的具体做法

本轮没有直接把完整工具文档喂给模型，而是做了几条收缩:

1. 每次只做一次 LLM 路由调用。
2. 提示词里只放候选工具，而不是整套库 API。
3. 先用本地规则提取 `bbox`、日期、数据集，再把这些作为 hints 发给模型。
4. 给模型的候选工具会按启发式缩小范围，而不是每次都让它在大空间里搜索。
5. 使用结构化输出，避免模型长篇解释。
6. LLM 只读取 `tool_library.py` 生成的压缩 catalog，而不是完整 Markdown 文档。

当前这套模式的本质是:

**用最少的 token，让 LLM 只做它最擅长的部分。**

### 5.9 Token 统计开关

本轮新增了一个可开关的 token 统计能力，用于观察一次完整问答过程中 LLM 路由阶段的 token 消耗。

开启方式:

1. 命令行:
   - `--token-stats`
2. 环境变量:
   - `HYDRAFLOODS_TOKEN_TRACE=1`

当前统计范围:

1. LLM 路由调用的 `prompt_tokens`
2. LLM 路由调用的 `completion_tokens`
3. 总 `total_tokens`

说明:

1. 当前工具执行本身主要是本地代码和 GEE 计算，不消耗 LLM token。
2. 因此这份统计主要反映“自然语言解析与工具选择”阶段的模型成本。

## 6. 当前自然语言请求到工具的映射

当前规则很简单，但已经够演示这套范式:

1. 先由本地规则抽 hints。
2. 再由 LLM 输出:
   - `selected_tool`
   - `dataset`
   - `dates`
   - `bbox`
   - `algorithm`
   - `reference`
3. 再由工具注册表补出标准 `intent`
4. 最后执行对应任务工具

## 7. 与上一版实验相比，变化在哪里

上一版的问题是:

1. LangGraph 节点里直接写了大量 HYDRAFloods 调用细节。
2. 业务逻辑、显示逻辑、编排逻辑混在一起。
3. 不够像“可迁移的工具层”，更像一个临时脚本。

这一版的变化是:

1. HYDRAFloods 调用集中到 `tool_adapters.py`
2. agent 本体只保留解析、选工具、格式化
3. `tile_url` 成为工具层标准输出之一
4. Sentinel-1 的稳态参数也放到了工具层，而不是塞进 agent 节点
5. 自然语言解析已经从纯关键词升级为“规则 hints + LLM 结构化路由”
6. 工具元数据已经形成独立工具库注册表

## 8. 当前边界

本轮仍然是最小实现，不是完整生产方案。

当前边界包括:

1. 自然语言解析目前是“规则 hints + 一次 LLM 路由”，不是多步 planner。
2. 工具层目前只覆盖最小 4 个任务。
3. `Modis`、`Viirs`、`kmeans_extent` 只做能力登记，未做重点实测。
4. 还没有加入回归测试集和自动评估。
5. 还没有把工具层接进主项目 `agent/`。

## 9. 本地验证结果

本轮至少验证了以下链路:

1. 工具清单查询可正常输出。
2. `get_water_extent_tile` 可真实执行，并返回 `tile_url` 和 `thumbnail_url`。
3. `get_flood_extent_tile` 可真实执行，并返回 `tile_url` 和 `thumbnail_url`。
4. `estimate_flood_depth_tile` 可真实执行，并返回 `tile_url` 和 `thumbnail_url`。
5. LangGraph 代理已经通过工具层完成任务，而不是直接执行 HYDRAFloods 逻辑。
6. 更自然的中文请求可以通过 LLM 路由正确映射到本地工具。
7. 工具选择已经基于独立工具库注册表，而不是基于 agent 内部硬编码说明。
8. token 统计默认关闭，开启后可在最终输出和 JSON 状态中看到本次问答的 token 用量。

补充观察:

1. Sentinel-1 路径需要在工具层显式补 `thresh_no_data`，否则 `edge_otsu` 可能出现空 histogram。
2. `extract_flood` 依赖 `system:time_start`，因此工具层为观测影像补了时间属性。
3. 当前运行会看到 JRC `MonthlyRecurrence` 旧资产的废弃告警，这提示后续如果维护 fork，可以考虑把相关引用升级到 `JRC/GSW1_4`。

## 10. 这个模式在工程上的推荐落地方式

如果后面继续扩展，最推荐的路径是:

1. 保持 `hydrafloods` fork 为独立库项目。
2. 在 SatGPT 中维护一层本地工具适配模块。
3. 维护一份独立工具库注册表，作为人类和 LLM 的共同入口。
4. LangGraph 代理只消费工具层和工具库，而不直接消费 fork 库内部 API。
5. 新功能优先加成新的任务工具，而不是不断扩展 agent 节点复杂度。

## 11. 下一步建议

接下来最值得做的是:

1. 给 `tool_adapters.py` 补测试。
2. 给 `tool_library.py` 增加版本字段和变更记录字段。
2. 再补两个工具:
   - `get_water_extent_stats`
   - `export_flood_asset`
3. 把这层工具接口迁移到主项目 `agent/`，让前端直接消费 `tile_url`。

## 12. 一句话总结

这次实验已经从“LangGraph 直接写业务逻辑”升级成了更标准的形态:

**旧库保持纯粹，新增任务级工具层，LangGraph 只做编排。**
