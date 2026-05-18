/**
 * CopilotKit Runtime 服务。
 * 使用 Express 暴露运行时接口，并把请求转发给 Python LangGraph Agent。
 */
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  EmptyAdapter,
} from '@copilotkit/runtime';
import { LangGraphHttpAgent } from '@copilotkit/runtime/langgraph';

import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, "..", ".env") });

const app = express();
const FRONTEND_PORT = process.env.FRONTEND_PORT || "3000";
const PUBLIC_HOST = process.env.SATGPT_PUBLIC_HOST || "localhost";

function getAllowedCorsOrigins(): string[] {
  const origins = new Set([
    `http://localhost:${FRONTEND_PORT}`,
    `http://127.0.0.1:${FRONTEND_PORT}`,
  ]);

  const configured = (process.env.SATGPT_CORS_ORIGINS || "").trim();
  if (configured) {
    configured
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
      .forEach((origin) => origins.add(origin));
  }

  if (!["localhost", "127.0.0.1", "0.0.0.0"].includes(PUBLIC_HOST)) {
    origins.add(`http://${PUBLIC_HOST}:${FRONTEND_PORT}`);
  }

  return [...origins];
}

const allowedCorsOrigins = getAllowedCorsOrigins();

// CORS 配置：允许前端从不同来源访问运行时服务。
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedCorsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));

// 允许较大的 JSON 请求体，兼容地图与分析结果载荷。
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Python LangGraph 后端地址（FastAPI）。
const AGENT_PORT = process.env.AGENT_PORT || "8000";
const AGENT_URL = process.env.AGENT_URL || `http://localhost:${AGENT_PORT}`;

// CopilotKit 需要的空服务适配器。
const serviceAdapter = new EmptyAdapter();

// 初始化 CopilotRuntime，并注册 flood_agent。
const runtime = new CopilotRuntime({
  agents: {
    flood_agent: new LangGraphHttpAgent({
      url: `${AGENT_URL}/agent`,
    }) as any,
  },
});

// 构建 CopilotKit HTTP 处理器。
const handler = copilotRuntimeNodeHttpEndpoint({
  runtime,
  serviceAdapter,
  endpoint: "/copilotkit",
});

// 包一层错误处理，统一处理客户端取消请求的场景。
const wrappedHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handler(req, res);
  } catch (error: any) {
    // 客户端主动取消请求时，返回 499。
    if (error?.message?.includes('aborted') || 
        error?.message?.includes('Aborted') ||
        error?.name === 'AbortError') {
      console.log('[INFO] Request aborted by client');
      // headers 尚未发送时，显式返回取消状态。
      if (!res.headersSent) {
        res.status(499).json({ message: 'Request cancelled by client' });
      }
      return;
    }
    // 其他错误交给全局错误处理中间件。
    next(error);
  }
};

// 暴露 CopilotKit 入口。
app.post("/copilotkit", wrappedHandler);

// 健康检查接口。
app.get("/health", (_req: Request, res: Response) => {
  res.json({ 
    status: "ok", 
    service: "copilotkit-runtime",
    agentUrl: AGENT_URL
  });
});

// 全局错误处理中间件。
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  // 再次兜底处理 abort 错误。
  if (err?.message?.includes('aborted') || err?.message?.includes('Aborted')) {
    console.log('[INFO] Operation cancelled');
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

// 启动 Runtime 服务。
const PORT = parseInt(process.env.RUNTIME_PORT || "5000");
const HOST = process.env.RUNTIME_HOST || "0.0.0.0";

app.listen(PORT, HOST, () => {
  console.log("[INFO] CopilotKit runtime started");
  console.log(`   - Runtime URL: http://${HOST}:${PORT}/copilotkit`);
  console.log(`   - LangGraph backend: ${AGENT_URL}`);
  console.log(`   - CORS origins: ${allowedCorsOrigins.join(", ")}`);
});
