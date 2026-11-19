import { readFileSync, writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';

export function readBinding(sessionId) {
  if (!/^satgpt-[a-f0-9]{32}$/.test(sessionId) || !process.env.SATGPT_RUN_BINDINGS) return null;
  try {
    const file = path.join(process.env.SATGPT_RUN_BINDINGS, sessionId + '.json');
    const binding = JSON.parse(readFileSync(file, 'utf8'));
    return binding.session_id === sessionId ? binding : null;
  } catch {
    return null;
  }
}

export function mountControl(ctx, runWorker) {
  const token = process.env.SATGPT_CONTROL_TOKEN;
  const portFile = process.env.SATGPT_CONTROL_PORT_FILE;
  if (!token || !portFile) throw new Error('SatGPT runtime control configuration is missing');
  const authorized = Buffer.from('Bearer ' + token);
  const server = http.createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const bearer = Buffer.from(req.headers.authorization || '');
    if (bearer.length !== authorized.length || !timingSafeEqual(bearer, authorized)) {
      res.writeHead(403).end();
      return;
    }
    const reply = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') {
      reply(200, { ready: true });
      return;
    }
    if (req.method !== 'POST' || !['/cancel', '/reload', '/reasoning'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size < 2 || size > 1_000_000) {
      res.writeHead(413).end();
      return;
    }
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const chunks = [];
      // Node enforces the declared Content-Length before this request boundary.
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url === '/reasoning') {
        const { name, reasoning } = await ctx.llm.resolveModelInfo(body.provider, body.model, abort.signal);
        const levels = reasoning?.efforts.map(({ id, name }) => ({ id, name })) ?? [];
        reply(200, { model: name, levels, default_effort: reasoning?.defaultEffort ?? null });
        return;
      }
      if (req.url === '/cancel') {
        const binding = readBinding(body.session_id);
        if (!binding || binding.run_id !== body.run_id) {
          reply(404, { accepted: false });
          return;
        }
        const agent = ctx.agents.get(binding.session_id);
        const accepted = agent?.status === 'running';
        if (accepted) agent.cancel({ kind: 'user' });
        reply(200, { accepted });
        return;
      }
      if (typeof body.owner_id !== 'string' || !/^[a-f0-9]{32}$/.test(body.owner_id)) {
        reply(400, { error: 'Invalid reload owner' });
        return;
      }
      const result = await runWorker(body.owner_id, body.payload, abort.signal);
      reply(200, result);
    } catch (error) {
      if (!abort.signal.aborted) reply(422, { error: String(error?.message || 'Runtime request failed').slice(0, 500) });
    }
  });
  server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port), { mode: 0o600 }));
  ctx.on('dispose', () => { server.closeAllConnections(); server.close(); });
}

