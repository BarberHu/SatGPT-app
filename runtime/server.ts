/**
 * CopilotKit Runtime 服务。
 * 使用 Express 暴露运行时接口，并把请求转发给 Python LangGraph Agent。
 */
import express, { Request, Response, NextFunction } from "express";
import { resolve } from "node:path";
import {
  CopilotRuntime,
  copilotRuntimeNodeHttpEndpoint,
  EmptyAdapter,
} from '@copilotkit/runtime';
import { LangGraphHttpAgent } from '@copilotkit/runtime/langgraph';

import dotenv from "dotenv";

dotenv.config({ path: resolve(process.cwd(), "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const app = express();
const SERVICE_HOST = requireEnv("SATGPT_SERVICE_HOST");

// 允许较大的 JSON 请求体，兼容地图与分析结果载荷。
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Python LangGraph 后端地址（FastAPI）。
const AGENT_PORT = requireEnv("AGENT_PORT");
const AGENT_URL = `http://${SERVICE_HOST}:${AGENT_PORT}`;

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
const PORT = Number.parseInt(requireEnv("RUNTIME_PORT"), 10);
const HOST = requireEnv("RUNTIME_HOST");

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("RUNTIME_PORT must be an integer between 1 and 65535");
}

app.listen(PORT, HOST, () => {
  console.log("[INFO] CopilotKit runtime started");
  console.log(`   - Runtime URL: http://${HOST}:${PORT}/copilotkit`);
  console.log(`   - LangGraph backend: ${AGENT_URL}`);
});
