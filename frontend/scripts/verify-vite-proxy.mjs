import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = path.join(frontendRoot, 'node_modules', 'vite', 'bin', 'vite.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

async function waitForVite(url, child, output) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Vite exited before becoming ready.\n${output.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Vite.\n${output.join('')}`);
}

const agent = http.createServer((request, response) => response.end(`agent:${request.url}`));
const runtime = http.createServer((request, response) => response.end(`runtime:${request.url}`));
const agentPort = await listen(agent);
const runtimePort = await listen(runtime);
const frontendPort = await reservePort();
const output = [];

const vite = spawn(process.execPath, [viteBin], {
  cwd: frontendRoot,
  env: {
    ...process.env,
    FRONTEND_HOST: '127.0.0.1',
    FRONTEND_PORT: String(frontendPort),
    SATGPT_SERVICE_HOST: '127.0.0.1',
    AGENT_PORT: String(agentPort),
    RUNTIME_PORT: String(runtimePort),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

vite.stdout.on('data', (chunk) => output.push(chunk.toString()));
vite.stderr.on('data', (chunk) => output.push(chunk.toString()));

try {
  const baseUrl = `http://127.0.0.1:${frontendPort}`;
  await waitForVite(baseUrl, vite, output);

  const expectations = new Map([
    ['/api/probe', 'agent:/api/probe'],
    ['/health', 'agent:/health'],
    ['/agent', 'agent:/agent'],
    ['/copilotkit', 'runtime:/copilotkit'],
  ]);

  for (const [route, expected] of expectations) {
    const response = await fetch(`${baseUrl}${route}`);
    const body = await response.text();
    if (!response.ok || body !== expected) {
      throw new Error(`${route} returned ${response.status} ${JSON.stringify(body)}; expected ${JSON.stringify(expected)}`);
    }
  }

  console.log(`Verified ${expectations.size} Vite same-origin proxy routes.`);
} finally {
  vite.kill();
  await Promise.all([close(agent), close(runtime)]);
}
