# SatGPT + FloodAgent 集成版

这是 SatGPT 卫星遥感平台与 FloodAgent 洪水智能体的集成版本。

## 项目架构

```
SatGPT-app/
├── app.py                 # Flask 后端 (端口 5001)
├── agent/                 # FloodAgent 智能体后端
│   ├── server.py          # FastAPI 服务 (端口 8000)
│   ├── flood_agent.py     # LangGraph 智能体
│   └── gee_service.py     # GEE 影像服务
├── runtime/               # CopilotKit Runtime
│   └── server.ts          # Express 中间层 (端口 5000)
├── frontend/              # React 前端 (端口 3000)
│   └── src/
│       ├── components/
│       │   ├── ControlPanel.js   # 控制面板（含模式切换）
│       │   ├── AgentPanel.js     # 智能体聊天面板
│       │   └── MapContainer.js   # 地图组件
│       └── context/
│           └── AppContext.js     # 状态管理
└── start_all.bat          # 一键启动脚本
```

## 快速开始

### 1. 安装依赖

```bash
# 安装 Python 依赖
pip install -r requirements.txt
pip install -r agent/requirements.txt

# 安装 Runtime 依赖
cd runtime && npm install

# 安装前端依赖
cd frontend && npm install
```

### 2. 配置环境变量

```bash
# 复制示例配置
cp .env.example .env

# 编辑 .env 文件，填写：
# - OPENAI_API_KEY
# - TAVILY_API_KEY
# - GEE_PROJECT_ID
# - MAPBOX_ACCESS_KEY
```

### 3. 启动服务

**方式一：一键启动**
```bash
# Windows
start_all.bat
```

**方式二：分别启动**
```bash
# 终端1: Flask 后端
python app.py

# 终端2: FastAPI Agent
cd agent && python server.py

# 终端3: CopilotKit Runtime
cd runtime && npm run dev

# 终端4: React 前端
cd frontend && npm start
```

### 4. 访问应用

打开浏览器访问 http://localhost:3000

## 功能说明

### 传统模式
- 选择网格区域
- 查询历史洪水数据
- 查看洪水热点分析
- 多图层叠加显示

### 智能体模式
- 自然语言查询洪水事件
- AI 自动搜索并提取信息
- Human-in-the-Loop 确认
- 自动生成洪水分析报告
- Sentinel-1/2 卫星影像对比
- 洪水变化检测

## 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| Flask 后端 | 5001 | 原有 SatGPT 功能 |
| FastAPI Agent | 8000 | FloodAgent 智能体 |
| CopilotKit Runtime | 5000 | 前端与智能体的桥梁 |
| React 前端 | 3000 | Web 界面 |

## 注意事项

1. 确保 GEE 已正确配置认证
2. 智能体模式需要 OpenAI API 和 Tavily API
3. 首次使用需要安装所有依赖
