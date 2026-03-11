/**
 * CopilotKit 运行时服务器 (v1.10.6)
 * 使用 Express 作为代理，连接 React 前端和 Python LangGraph 后端
 */
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  EmptyAdapter,
} from '@copilotkit/runtime';
import { LangGraphHttpAgent } from '@copilotkit/runtime/langgraph';

import dotenv from "dotenv";

dotenv.config();

const app = express();

// CORS 配置 - 允许所有来源访问（支持内网/局域网访问）
app.use(cors({
  origin: true,
  credentials: true,
}));

// 解析 JSON - 增加请求体大小限制
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Python LangGraph 后端地址 (FastAPI)
const AGENT_URL = process.env.AGENT_URL || "http://localhost:8000";

// 使用空适配器（因为我们只用一个 agent）
const serviceAdapter = new EmptyAdapter();

// 创建 CopilotRuntime 实例并配置 LangGraph 代理
const runtime = new CopilotRuntime({
  agents: {
    flood_agent: new LangGraphHttpAgent({
      url: `${AGENT_URL}/agent`,
    }),
  },
});

// 创建 CopilotKit 端点
const handler = copilotRuntimeNodeHttpEndpoint({
  runtime,
  serviceAdapter,
  endpoint: "/copilotkit",
});

// 包装处理器以捕获 abort 错误
const wrappedHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handler(req, res);
  } catch (error: any) {
    // 检查是否是 abort 错误
    if (error?.message?.includes('aborted') || 
        error?.message?.includes('Aborted') ||
        error?.name === 'AbortError') {
      console.log('ℹ️ Request aborted by client');
      // 如果响应还没发送，返回一个友好的响应
      if (!res.headersSent) {
        res.status(499).json({ message: 'Request cancelled by client' });
      }
      return;
    }
    // 其他错误传递给错误处理中间件
    next(error);
  }
};

// 挂载到 Express
app.post("/copilotkit", wrappedHandler);

// 健康检查端点
app.get("/health", (_req: Request, res: Response) => {
  res.json({ 
    status: "ok", 
    service: "copilotkit-runtime",
    agentUrl: AGENT_URL
  });
});

// 全局错误处理中间件
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  // 忽略 abort 错误
  if (err?.message?.includes('aborted') || err?.message?.includes('Aborted')) {
    console.log('ℹ️ Operation cancelled');
    if (!res.headersSent) {
      res.status(499).end();
    }
    return;
  }
  
  console.error('Runtime error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message });
  }
});

// 启动服务器
const PORT = parseInt(process.env.RUNTIME_PORT || "5000");
const HOST = process.env.RUNTIME_HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log(`🚀 CopilotKit 运行时服务器已启动`);
  console.log(`   - 运行时地址: http://${HOST}:${PORT}/copilotkit`);
  console.log(`   - LangGraph 后端: ${AGENT_URL}`);
});
