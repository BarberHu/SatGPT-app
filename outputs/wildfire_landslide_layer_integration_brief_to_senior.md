# SatGPT Pro Wildfire / Landslide 默认图层集成评估与进展汇报

## 1. 结论

目前判断：默认图层层面的集成可以低成本完成，不需要重写 Agent，也暂时不需要 NaraSpace 介入。

原因是现有 SatGPT Agent 模式里，影像图层、矢量图层和 Mapbox 渲染链路已经具备复用基础。真正需要扩展的是 Raster Layers 的配置和后端 GEE tile 生成逻辑。

简单说，这次不是新做一个完整 Wildfire Agent，而是先把“森林模块的图层面板能力”接到 SatGPT Pro 现有 Agent 工作区中。

## 2. 已完成工作

我已经基于现有 Agent 模式做了默认图层复用改造：

1. 影像图层复用原有逻辑  
   继续复用 Sentinel-2 / Sentinel-1 影像开关，不新增独立影像管理链路。

2. 矢量图层复用原有逻辑  
   继续复用现有 `businessLayers` / 空间范围图层管理逻辑。

3. Raster Layers 改成模块化配置  
   把原来偏 Flood 专属的 raster 图层逻辑，拆成可按灾种配置的结构。现在 Flood、Wildfire、Landslide 可以走同一套图层面板、状态管理和地图渲染流程。

4. Wildfire 默认图层已接入并验证  
   当前接入：
   - Active Fire Detections
   - Population Exposure
   - Fuel / Land Cover

5. Landslide 默认图层也做了复用验证  
   当前接入：
   - Slope Steepness
   - Population Exposure
   - Land Cover Context

## 3. 技术方案概括

目前采用的是“配置驱动 + 通用图层面板 + 后端 key 扩展”的方式。

流程可以理解为：

```text
Agent 模块选择
  -> 根据 flood / wildfire / landslide 读取对应 raster 配置
  -> 前端通用图层面板展示
  -> AppContext 统一管理图层状态
  -> 请求后端 /api/agent-raster-layers
  -> 后端根据 layer_key 生成 GEE tile URL
  -> MapContainer 同步到 Mapbox 地图
```

这个方案的好处是：以后新增灾种时，不需要复制一整套 panel，只需要补充配置和对应的后端 GEE 图层生成逻辑。

## 4. 验证结果

目前已经完成基础验证：

- 前端可以正常切换 Wildfire / Landslide 模块。
- Wildfire 默认图层可以请求后端并加载到地图。
- Landslide 默认图层可以请求后端并加载到地图。
- 后端新增的 raster key 可以正常返回 GEE tile URL。
- 前端打包通过。
- 后端 Python 编译检查通过。

之前遇到的 Wildfire 图层 500 问题，主要是后端 GEE 图层生成逻辑和空数据防御不足导致的，不是前端面板复用路线的问题。目前已做修正。

## 5. 当前边界

需要说明的是，目前完成的是“默认图层集成”和“图层管理逻辑复用”，不是完整 Wildfire / Landslide Agent 能力。

目前暂未完成：

1. Wildfire 的完整分析工作流  
   例如火点时间序列分析、火灾扩散推理、火灾风险模型等。

2. Landslide 的完整易发性模型  
   目前 Landslide 先用 SRTM slope 作为合理的第一层默认图层，适合做最小成本验证，但还不是完整滑坡危险性评价。

3. Burn Severity / Fire Weather Index  
   这两个图层暂时没有强行接入。原因是它们需要更明确的数据契约，比如火前/火后时间窗口，或者外部模型服务。如果直接硬接，容易做成“看起来有按钮但结果不可靠”的半成品。

## 6. 对集成成本的判断

如果目标是“把森林/野火模块的默认图层接入 SatGPT Pro，并复用现有图层管理框架”，工作量不大，当前方案已经验证可行。

如果目标升级为“完整 Wildfire Agent”，则需要进一步确认：

- 需要哪些业务分析能力；
- 是否已有 NaraSpace 的算法服务或数据接口；
- 火灾相关图层的数据时间范围；
- 前端是否需要独立 workflow；
- 输出结果是否只是地图可视化，还是要包含 report / chart / agent reasoning。

因此我的建议是分两步：

第一步：先合并默认图层集成能力，保证 SatGPT Pro 里 Wildfire / Landslide 模块可以稳定显示基础图层。  
第二步：再评估是否接入更复杂的 Wildfire 分析模型。如果涉及 NaraSpace 的专有算法或接口，再邀请他们协作会更合适。

## 7. 后续建议

短期建议优先做三件事：

1. 确认 Wildfire 默认图层清单  
   目前建议保留 Active Fire Detections、Population Exposure、Fuel / Land Cover 作为第一版。

2. 确认是否需要 Burn Severity / Fire Weather Index  
   如果需要，需要先定义输入时间窗口和数据来源，否则不建议现在硬接。

3. 明确 SatGPT Pro 里 Wildfire 的目标  
   如果只是“展示森林/野火相关图层”，当前方案已经足够。  
   如果是“做野火分析 Agent”，还需要单独定义分析链路和接口需求。

## 8. 一句话总结

这次我先按最小成本路线验证了 Wildfire / Landslide 默认图层接入 SatGPT Pro 的可行性。结论是：图层层面可以复用现有 Agent 架构，工作量不大；复杂分析能力暂时不建议硬做，等明确数据接口和业务目标后再决定是否需要 NaraSpace 参与。
