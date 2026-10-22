SatGPT 浏览器回归测试

依赖：Python、playwright、Google Chrome；项目的前端网关、Agent 和 Copilot
runtime 需要按项目 README 启动并配置可用的 GEE / LLM 服务。
浏览器使用独立的无头 Chrome 上下文，不复用个人浏览器数据。

在项目根目录运行，按实际网关地址覆盖 --base-url：
  python scripts/testing/deep_ui_checks.py --base-url http://127.0.0.1:13000
  python scripts/testing/deep_agent_flow.py --base-url http://127.0.0.1:13000 --confirmation-only
  python scripts/testing/fix_ask_raster_smoke.py --base-url http://127.0.0.1:13000

deep_ui_checks.py：17 项基础交互、AOI 校验、范围切换、下载及失败恢复检查。
  用 --only D03 D04 D05 D06 D12 D15 可仅复验本次 AOI / 图层修复。
deep_agent_flow.py --confirmation-only：真实事件提取、日期校验、空图层选择及取消。
  不加该参数会继续探测报告与 GEE 代码导出；该链路仍有已知断点，本次没有修复。
fix_ask_raster_smoke.py：Ask Enter / 输入法处理，以及真实栅格 API 的 400 / 200。

这些脚本会请求真实 GEE / LLM 服务。标为 FAULT INJECTION 的检查仅把第一次
请求改为 503，移除拦截后使用真实服务验证恢复；它们不代表生产服务实际故障。
LLM 返回内容及外部网络会影响运行时间和稳定性。

用 --output 指定证据目录，默认在 outputs/regression/ 下保存 JSON 与截图。
失败返回非零退出码；截图保存失败单独记录，不改变功能断言结果。
所有脚本均支持 --help。测试输出、截图及本地缓存不应提交到 Git。

本机 localhost 的 Copilot 检查器可能遮挡按钮；可用同一服务的其他回环地址
（如 http://127.0.0.2:13000）复核，但网关需要允许该回环地址访问。

代码级回归（项目根目录）：
  npm --prefix frontend test
  npm --prefix frontend run build
  node --test scripts/tests/gateway.test.cjs
  flood-venv/Scripts/python.exe -m unittest discover -s agent/tests
