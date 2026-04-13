# CLAUDE 风格项目初始化表

用途：给大模型或新接手开发者做“快速装载上下文”的作战卡。

目标：尽量少读文件，也能在正确位置开工。

---

## 1. 项目身份

| 项目项 | 内容 |
|---|---|
| 项目名 | `SatGPT Flood Analysis Platform` |
| 核心目标 | 基于大模型、Google Earth Engine、Mapbox 做洪水事件分析与可视化 |
| 当前形态 | `Legacy Basic` + `Agent Advanced` 双轨并存 |
| 主要语言 | Python、JavaScript、TypeScript |
| 核心外部依赖 | OpenAI、Tavily、Google Earth Engine、Mapbox、CopilotKit、LangGraph |
| 前端入口 | [`frontend/src/App.js`](E:\GMS\Flood\SatGPT-app\frontend\src\App.js) |
| 新后端入口 | [`agent/server.py`](E:\GMS\Flood\SatGPT-app\agent\server.py) |
| 旧后端入口 | [`app.py`](E:\GMS\Flood\SatGPT-app\app.py) |
| Runtime 桥接层 | [`runtime/server.ts`](E:\GMS\Flood\SatGPT-app\runtime\server.ts) |

---

## 2. 先记住这条总链路

```text
Frontend
  -> Runtime
    -> FastAPI Agent
      -> LangGraph state machine
        -> AOI resolve / dataset recommend / GEE compute
```

旧链路是旁路：

```text
Frontend Ask mode
  -> Flask app.py
```

---

## 3. 各层入口速查

| 关注点 | 第一入口文件 | 第二入口文件 | 备注 |
|---|---|---|---|
| Agent 模式 API | [`agent/server.py`](E:\GMS\Flood\SatGPT-app\agent\server.py) | [`frontend/src/services/agentApi.js`](E:\GMS\Flood\SatGPT-app\frontend\src\services\agentApi.js) | `/api/flood-images`、`/api/flood-impact`、`/api/flood-confirmation/refresh` |
| Agent 状态 | [`agent/state.py`](E:\GMS\Flood\SatGPT-app\agent\state.py) | [`frontend/src/context/AppContext.js`](E:\GMS\Flood\SatGPT-app\frontend\src\context\AppContext.js) | 前后端共享洪水事件状态 |
| Agent 流程 | [`agent/flood_agent.py`](E:\GMS\Flood\SatGPT-app\agent\flood_agent.py) | [`agent/prompts.py`](E:\GMS\Flood\SatGPT-app\agent\prompts.py) | 事件搜索、确认、报告与代码生成 |
| GEE 遥感分析 | [`agent/gee_service.py`](E:\GMS\Flood\SatGPT-app\agent\gee_service.py) | [`agent/gee_code_generator.py`](E:\GMS\Flood\SatGPT-app\agent\gee_code_generator.py) | 洪水检测与 impact assessment 核心 |
| AOI 统一抽象 | [`agent/flood_aoi.py`](E:\GMS\Flood\SatGPT-app\agent\flood_aoi.py) | [`frontend/src/utils/aoi.js`](E:\GMS\Flood\SatGPT-app\frontend\src\utils\aoi.js) | 新主线，优先理解 |
| 数据集选择 | [`agent/config/flood_dataset_registry.json`](E:\GMS\Flood\SatGPT-app\agent\config\flood_dataset_registry.json) | [`agent/flood_dataset_service.py`](E:\GMS\Flood\SatGPT-app\agent\flood_dataset_service.py) | 新主线，优先理解 |
| 地图渲染 | [`frontend/src/components/MapContainer.js`](E:\GMS\Flood\SatGPT-app\frontend\src\components\MapContainer.js) | [`frontend/src/components/AgentPanel.js`](E:\GMS\Flood\SatGPT-app\frontend\src\components\AgentPanel.js) | tile URL、AOI 绘制、图层开关 |
| Legacy 旧图层 | [`app.py`](E:\GMS\Flood\SatGPT-app\app.py) | [`frontend/src/config/layerCatalog.json`](E:\GMS\Flood\SatGPT-app\frontend\src\config\layerCatalog.json) | historical / hotspot / regime change |

---

## 4. 你必须理解的三个核心对象

### 4.1 AOI

标准 AOI 是新主线里的统一空间输入对象，核心字段包括 `version`、`source`、`label`、`kind`、`bounds`、`geojson`、`legacy.AoI_cords`。

如果修改和范围、上传、绘制、边界确认相关的逻辑，优先看：

- [`agent/flood_aoi.py`](E:\GMS\Flood\SatGPT-app\agent\flood_aoi.py)
- [`frontend/src/utils/aoi.js`](E:\GMS\Flood\SatGPT-app\frontend\src\utils\aoi.js)

### 4.2 Flood Agent State

这是 Agent 模式的共享上下文，包含洪水事件名、预洪/峰值/灾后日期、AOI 相关字段、`flood_report`、生成的 GEE JavaScript，以及确认状态。

入口是 [`agent/state.py`](E:\GMS\Flood\SatGPT-app\agent\state.py)。

### 4.3 数据集注册表

当前精选洪水资产由注册表驱动，而不是完全写死在代码里。

入口是 [`agent/config/flood_dataset_registry.json`](E:\GMS\Flood\SatGPT-app\agent\config\flood_dataset_registry.json)。

关键事实如下：

| 项 | 说明 |
|---|---|
| `selection_mode` | 当前是 `curated_only` |
| `assets[]` | 定义 `asset_id`、标题、推荐优先级、渲染方式、legend、执行参数 |
| 服务消费方式 | [`agent/flood_dataset_service.py`](E:\GMS\Flood\SatGPT-app\agent\flood_dataset_service.py) 会把注册表和 `experiments/water_asset_agent` catalog 合并消费 |

---

## 5. 请求路由判断表

| 用户动作 / 需求 | 默认走向 | 先看哪里 |
|---|---|---|
| 用户在聊天区问洪水事件 | Agent 新链路 | [`agent/flood_agent.py`](E:\GMS\Flood\SatGPT-app\agent\flood_agent.py) |
| 用户确认洪水事件后请求出图 | FastAPI + GEE | [`agent/server.py`](E:\GMS\Flood\SatGPT-app\agent\server.py) + [`agent/gee_service.py`](E:\GMS\Flood\SatGPT-app\agent\gee_service.py) |
| 用户上传或绘制 AOI | 前端 AOI 工具链 | [`frontend/src/utils/aoi.js`](E:\GMS\Flood\SatGPT-app\frontend\src\utils\aoi.js) + [`frontend/src/components/AoiUploadPanel.js`](E:\GMS\Flood\SatGPT-app\frontend\src\components\AoiUploadPanel.js) |
| 用户在旧面板点 historical / hotspot | Legacy 旧链路 | [`app.py`](E:\GMS\Flood\SatGPT-app\app.py) + [`frontend/src/services/api.js`](E:\GMS\Flood\SatGPT-app\frontend\src\services\api.js) |
| 用户下载 GEE 代码 | 新旧两条线都可能涉及 | 先判断当前 UI 模式，再看 `gee_code_generator.py` 或 `services/api.js` |

---

## 6. 新线和旧线的职责边界

| 维度 | Legacy / Basic | Agent / Advanced |
|---|---|---|
| 后端 | Flask | FastAPI |
| 前端入口 | `ControlPanel.js` / `ChatBox.js` Ask 模式 | `AgentPanel.js` + CopilotKit |
| 主要能力 | historical map、hotspot、water regime change | 洪水事件搜索、确认、AOI、数据集推荐、洪水检测、impact assessment |
| 图层配置 | `frontend/src/config/layerCatalog.json` | `agent/config/flood_dataset_registry.json` |
| 风险 | 历史逻辑较多、接口较老 | 正在演化，抽象层更多 |

结论：想修稳定功能，先确认是不是 Legacy 线；想扩展智能工作流、AOI、多资产推荐，优先走 Agent 线。

---

## 7. 快速启动知识

| 项目 | 值 |
|---|---|
| 一键启动脚本 | [`start_all.bat`](E:\GMS\Flood\SatGPT-app\start_all.bat) |
| 并行分支 / worktree 启动脚本 | [`start_agent_layer.bat`](E:\GMS\Flood\SatGPT-app\start_agent_layer.bat) |
| React 端口 | `3000` |
| Runtime 端口 | `5000` |
| Flask 端口 | `5001` |
| FastAPI 端口 | `8000` |
| 环境变量模板 | [`.env.example`](E:\GMS\Flood\SatGPT-app\.env.example) |

必须可用的配置是 `OPENAI_API_KEY`、`TAVILY_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`GEE_PROJECT_ID`、`REACT_APP_MAPBOX_ACCESS_KEY`。

---

## 8. 模型进入仓库后的推荐动作顺序

如果你是大模型，别做开放式漫游，按下面顺序装载上下文：

1. 看 [`docs/项目初始化总览.md`](E:\GMS\Flood\SatGPT-app\docs\项目初始化总览.md)。
2. 看 [`agent/server.py`](E:\GMS\Flood\SatGPT-app\agent\server.py) 判断新后端接口边界。
3. 看 [`agent/flood_aoi.py`](E:\GMS\Flood\SatGPT-app\agent\flood_aoi.py) 理解 AOI 标准对象。
4. 看 [`agent/config/flood_dataset_registry.json`](E:\GMS\Flood\SatGPT-app\agent\config\flood_dataset_registry.json) 理解新线图层入口。
5. 看 [`frontend/src/components/AgentPanel.js`](E:\GMS\Flood\SatGPT-app\frontend\src\components\AgentPanel.js) 和 [`frontend/src/components/MapContainer.js`](E:\GMS\Flood\SatGPT-app\frontend\src\components\MapContainer.js) 理解前端挂接点。
6. 最后再决定要不要进入 [`app.py`](E:\GMS\Flood\SatGPT-app\app.py) 旧链路。

---

## 9. 编辑策略建议

| 场景 | 优先改哪里 | 不要先碰哪里 |
|---|---|---|
| 统一空间输入 | `agent/flood_aoi.py`、`frontend/src/utils/aoi.js` | 先别直接到各个接口里散改 `AoI_cords` |
| 新增洪水相关精选数据集 | `agent/config/flood_dataset_registry.json` | 不要先把 `asset_id` 写死进多个组件 |
| 改 Agent 分析流程 | `agent/flood_agent.py`、`agent/state.py` | 不要先改 `MapContainer.js` 试图“补前端状态” |
| 改地图显示效果 | `MapContainer.js`、`AgentPanel.js` | 不要先怀疑 GEE 结果错，先排 tile/source/layer 生命周期 |
| 修旧版图层接口 | `app.py` + `frontend/src/services/api.js` | 不要误改 Agent API |

---

## 10. 当前高风险误判

### 误判 1：把旧线当成废代码

不对。旧线仍然是可运行能力，不是纯遗留垃圾。

### 误判 2：以为前端上传 AOI 只是 UI 功能

不对。它实质上牵涉 AOI 标准对象、bounds / geojson 归一化、Legacy 兼容字段，以及后端 GEE 入参一致性。

### 误判 3：以为“数据集推荐”只是一个 UI 下拉框

不对。它其实是项目未来的“图层控制平面”。

---

## 11. 一句话作战原则

**先判断自己在 Basic 线还是 Agent 线，再判断自己是在改“流程层”还是“数据层”，最后才动代码。**
