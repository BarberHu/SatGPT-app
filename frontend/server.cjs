const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const frontendRoot = __dirname;
const projectRoot = path.resolve(frontendRoot, '..');
const buildRoot = path.join(frontendRoot, 'build');

const config = require('./projectEnv.cjs');
const env = config.loadProjectEnv(projectRoot);
config.validateFrontend(env, { map: false }); // map settings are compiled public values
const host = env.SATGPT_ALLOW_REMOTE_HARNESS === 'true' ? env.FRONTEND_HOST : '127.0.0.1';
const port = config.port(env, 'FRONTEND_PORT');
const serviceHost = env.SATGPT_SERVICE_HOST;
const basicTarget = new URL(`http://${env.BASIC_SERVICE_HOST || serviceHost}:${config.port(env, 'AGENT_PORT')}`);
const harnessTarget = new URL(`http://${env.HARNESS_SERVICE_HOST || serviceHost}:${config.port(env, 'HARNESS_PORT')}`);
const proxyTimeoutMs = config.positive(env, 'PROXY_TIMEOUT_MS');
const proxyMaxSockets = config.positive(env, 'PROXY_MAX_SOCKETS');

const upstreamAgent = new http.Agent({
  keepAlive: true,
  maxSockets: proxyMaxSockets,
  maxFreeSockets: 32,
});

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
}

function proxyRequest(req, res, target) {
  const forwardedFor = [req.headers['x-forwarded-for'], req.socket.remoteAddress]
    .filter(Boolean)
    .join(', ');
  const headers = {
    ...req.headers,
    host: target.host,
    'x-forwarded-for': forwardedFor,
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-proto': req.socket.encrypted ? 'https' : 'http',
  };

  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: req.url,
      headers,
      timeout: proxyTimeoutMs,
      agent: upstreamAgent,
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    }
  );

  upstream.on('timeout', () => upstream.destroy(new Error('Upstream request timed out')));
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'upstream_unavailable' }));
  });

  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

function requestJson(url) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 3000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

async function serveReadiness(res) {
  const [harness, basic] = await Promise.all([
    requestJson(new URL('/health', harnessTarget)),
    requestJson(new URL('/health', basicTarget)),
  ]);
  const ready = harness && basic;
  res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: ready ? 'ready' : 'degraded', harness, basic }));
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const requestedPath = path.resolve(buildRoot, `.${pathname}`);
  const safePath = requestedPath.startsWith(`${buildRoot}${path.sep}`) ? requestedPath : buildRoot;
  const filePath = fs.existsSync(safePath) && fs.statSync(safePath).isFile()
    ? safePath
    : path.join(buildRoot, 'index.html');

  if (!fs.existsSync(filePath)) {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'production_build_missing' }));
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  const isHashedAsset = pathname.startsWith('/static/');
  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const compressible = ['.css', '.html', '.js', '.json', '.svg', '.txt'].includes(extension);

  setSecurityHeaders(res);
  res.setHeader('Content-Type', mimeTypes[extension] || 'application/octet-stream');
  res.setHeader('Cache-Control', isHashedAsset
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200).end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  if (acceptsGzip && compressible) {
    res.setHeader('Content-Encoding', 'gzip');
    res.writeHead(200);
    stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
  } else {
    res.setHeader('Content-Length', stat.size);
    res.writeHead(200);
    stream.pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname === '/readyz') {
    await serveReadiness(res);
    return;
  }
  if (pathname.startsWith('/api/harness/') || pathname.startsWith('/api/previews/')) {
    proxyRequest(req, res, harnessTarget);
    return;
  }
  if (pathname.startsWith('/api/') || pathname === '/health') {
    proxyRequest(req, res, basicTarget);
    return;
  }
  if (!['GET', 'HEAD'].includes(req.method)) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  serveStatic(req, res);
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 65000;
server.requestTimeout = proxyTimeoutMs + 5000;
server.listen(port, host, () => {
  console.log(`[INFO] SatGPT production frontend listening at http://${host}:${port}`);
  console.log(`[INFO] Basic API upstream: ${basicTarget.origin}`);
  console.log(`[INFO] Harness upstream: ${harnessTarget.origin}`);
});
