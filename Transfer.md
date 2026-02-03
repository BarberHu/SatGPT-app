# Transfer

## 目标
将原 Flask 模板前端迁移为 React 外壳（保留现有 JS/HTML 逻辑），后端不改动业务逻辑，仅新增前端入口与配置接口。

## 实施方式
- 新增 React + Vite 前端壳，渲染 `/legacy` 返回的模板 DOM。
- 注入并重新执行 legacy 页面的内联脚本，保持现有交互不变。
- 通过 `/api/config` 提供 Mapbox/Google Maps key（替代 Jinja 注入）。
- Flask 根路由优先服务构建产物 `frontend/dist/index.html`；未构建时回退到原模板。

## 主要改动
### 新增前端目录
- `frontend/package.json`：React/Vite 依赖与构建脚本。
- `frontend/vite.config.js`：Vite 配置。
- `frontend/index.html`：React 入口 HTML，加载 legacy 所需三方库与原静态资源。
- `frontend/src/main.jsx`：React 入口。
- `frontend/src/App.jsx`：React 外壳，加载 `/legacy` 并执行 legacy 脚本。

### 后端路由调整
- `/`：优先返回 React 构建产物 `frontend/dist/index.html`，不存在则回退旧模板。
- `/legacy`：返回原 Flask 模板页面（保留现有 Jinja 变量）。
- `/api/config`：返回前端运行所需配置（Mapbox/Google Maps key）。
- `/assets/<path>`：提供 Vite 构建静态资源（`frontend/dist/assets`）。

### 兼容性调整
- `static/script.js`：将 `window.onload` 的逻辑迁移到 `water.onLegacyLoad`，由 React 注入 DOM 后主动触发。

### 文档与忽略项
- `README.md`：新增 React 前端构建步骤说明。
- `.gitignore`：忽略 `frontend/node_modules` 与 `frontend/dist`。

## 运行方式
```sh
cd frontend
npm install
npm run build
```
然后运行 Flask：
```sh
python app.py
```

## 备注
- 旧模板仍保留并可通过 `/legacy` 访问。
- React 壳方案未重写业务逻辑，仅复用原 DOM/JS。
