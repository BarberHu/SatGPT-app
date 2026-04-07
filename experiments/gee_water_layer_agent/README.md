# GEE Water Layer Agent Prototype

这个目录是一个独立测试原型，不接入主系统，不修改现有 Flask/FastAPI/前端流程。

## 目标

- 复用 SatGPT 的环境变量：
  - `OPENAI_API_KEY`
  - `OPENAI_API_BASE`
  - `LLM_MODEL`
  - `EE_ACCOUNT`
  - `EE_PRIVATE_KEY_FILE`
  - `GOOGLE_APPLICATION_CREDENTIALS`
  - `GEE_PROJECT_ID`
- 动态抓取 Google Earth Engine 官方 `water` 标签页中的全部数据集。
- 根据用户问题判断是否需要可视化图层。
- 如果需要，则从 `water` 标签数据集中选择最相关图层并渲染到 notebook 地图，供人工审核。

## 文件说明

- `water_gee_agent.py`：核心原型代码
- `requirements.txt`：仅供这个实验目录使用的依赖
- `water_layer_agent_review.ipynb`：人工审核入口 notebook

## 使用方式

1. 在仓库根目录准备 `.env`，并确保至少 GEE 认证可用。
   - 推荐显式设置 `EE_ACCOUNT` 与 `EE_PRIVATE_KEY_FILE`
   - 或者设置 `GOOGLE_APPLICATION_CREDENTIALS`，并确保 JSON 中包含 `client_email`
2. 打开本目录下的 `water_layer_agent_review.ipynb`。
3. 先执行安装依赖单元，再执行初始化单元。
4. 修改问题文本，例如：
   - `请帮我看看鄱阳湖附近的水体分布，最好直接上图`
   - `解释一下 JRC Global Surface Water 和 Global Flood DB 的差别`
5. 查看：
   - 是否判定需要可视化
   - 选了哪些官方数据集
   - 是否成功生成地图图层
   - 每个阶段的 token 使用明细（优先读取 API `usage`，否则用 `tiktoken` 估算）

## 官方数据来源

- 标签页：<https://developers.google.com/earth-engine/datasets/tags/water?hl=zh-cn>
- 每个数据集详情页：`https://developers.google.com/earth-engine/datasets/catalog/<slug>?hl=zh-cn`

## 说明

- 这个原型优先追求“可人工审核”的透明流程，而不是无缝接入现有系统。
- 目录内会在首次运行时生成 `cache/water_catalog.json` 作为抓取缓存。
- 如果没有 `OPENAI_API_KEY`，原型会退回启发式规则，仍可做基础测试。
- Notebook 地图默认使用“本地认证代理 tile”叠图，同时保留原始 `earth_engine_tile_url` 供审核。
