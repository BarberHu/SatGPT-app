# Water Asset Agent Prototype

这是一个独立的测试原型系统，用 `water` 标签页下的所有 GEE 数据集构建“结构化资产目录 + 智能检索选层 + tile URL 出图”能力。

## 原型目标

- 自动抓取官方 `water` 标签页下的全部数据集
- 构建结构化资产目录表
- 提取官方 dataset 页中的 `Bands` 和 `代码编辑器 (JavaScript)` 可视化示例
- 根据用户问题判断是否需要可视化
- 从候选 water 资产中选择最合适图层
- 基于官方 recipe + 校验器稳定生成 GEE `tile_url`
- 在 notebook 中把图层叠到底图上做人工审核

## 目录结构

- `catalog.py`：构建与加载结构化 water 资产目录，抽取 bands / 官方示例代码 / 可视化 recipe
- `tile_service.py`：GEE 初始化、recipe 校验、tile URL 生成、地图渲染
- `agent.py`：简化版智能体，只做查询解析、查表排序和出图编排
- `water_asset_agent_review.ipynb`：干净的 notebook 测试入口

## 环境变量

优先复用 SatGPT 根目录 `.env`：

- `OPENAI_API_KEY`
- `OPENAI_API_BASE`
- `LLM_MODEL`
- `EE_ACCOUNT`
- `EE_PRIVATE_KEY_FILE`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `GEE_PROJECT_ID`

## 使用方式

1. 在仓库根目录准备 `.env`
2. 打开 `water_asset_agent_review.ipynb`
3. 先安装依赖
4. 运行 catalog 构建单元
5. 输入测试问题，查看：
   - 结构化查询结果
   - 候选资产与最终选层
   - token 使用情况
   - GEE 认证信息
   - 资产波段与官方示例配方
   - 原始 GEE `earth_engine_tile_url`
   - 浏览器实际加载用的 `tile_url`
   - 备用本机代理 `proxy_tile_url`
   - 地图叠加效果

## 官方来源

- 标签页：[Google Earth Engine water datasets](https://developers.google.com/earth-engine/datasets/tags/water?hl=zh-cn)

## 说明

- 这是测试原型，不接主系统
- catalog 会缓存到 `cache/water_asset_catalog.json`
- 资产总表会同步导出到 `cache/water_asset_inventory.csv`
- 汇总统计会同步导出到 `cache/water_asset_inventory_summary.json`
- cache schema 升级后会自动刷新，避免继续读取旧版 catalog
- notebook 地图默认直接加载原始 GEE tile URL，同时保留 `proxy_tile_url` 作为备用调试路径
