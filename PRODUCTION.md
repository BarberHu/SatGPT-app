# SatGPT Production Deployment

## Production architecture

```text
Internet -> TLS load balancer / CDN -> Nginx frontend :8080
                                      |-- /api, /health, /agent -> FastAPI Agent :8000
                                      `-- /copilotkit            -> CopilotKit Runtime :5000
```

Only the frontend port is published. Agent and Runtime remain on the internal
container network. The frontend image serves the optimized React `build`
directory; it does not run the Create React App development server.

## Required configuration

Maintain secrets in the repository-root `.env` and `.private-key.json`. They are
excluded from both Git and Docker build contexts. The browser uses same-origin
relative URLs, so the public domain or server IP is deliberately not stored in
the application environment and does not require a rebuild when it changes.

Use these production defaults:

```env
SATGPT_SERVICE_HOST=127.0.0.1
AGENT_DEBUG=False
AGENT_WORKERS=1
SATGPT_HEAVY_CONCURRENCY=5
SATGPT_HEAVY_QUEUE_TIMEOUT_SECONDS=30
FRONTEND_PORT=3000
PROXY_TIMEOUT_MS=300000
PROXY_MAX_SOCKETS=256
```

`SATGPT_SERVICE_HOST` is an internal destination, never a public IP. Local
Windows processes use `127.0.0.1`; Docker Compose overrides it with the service
name `agent`, while Runtime is reached as `runtime`. Ports 5000 and 8000 remain
explicit internal service ports so the gateway knows where to route traffic,
but they are not published to the internet.

Browser access is supported only through the frontend gateway on the same
origin. Direct cross-origin browser access to Agent or Runtime is intentionally
unsupported. Public address changes are handled by DNS/load-balancer
configuration only.

If the production host requires an outbound proxy, set
`HTTP_PROXY` and `HTTPS_PROXY` directly. For containers, the proxy address must
be reachable from the container network; replace a developer-machine loopback
address such as `127.0.0.1` with a resolvable host address (for Docker Desktop,
typically `host.docker.internal`).

All required deployment values have one name. Local startup reads them from
`.env`; containers receive the same values through Docker Compose and do not
require an environment file inside an image.

Keep `AGENT_WORKERS=1` until LangGraph checkpoints, business-layer state, and
latest-script state have moved from process memory to a shared Redis/PostgreSQL
store. Multiple workers currently create inconsistent user sessions.

## Container deployment

```powershell
docker compose -f docker-compose.production.yml build --pull
docker compose -f docker-compose.production.yml up -d
docker compose -f docker-compose.production.yml ps
docker compose -f docker-compose.production.yml logs --tail 100
```

Verify the public entry point:

```powershell
curl http://127.0.0.1:3000/readyz
curl http://127.0.0.1:3000/health
```

Terminate with:

```powershell
docker compose -f docker-compose.production.yml down
```

Put a managed load balancer, ingress controller, or reverse proxy with a valid
TLS certificate in front of port 3000. Do not expose ports 5000 or 8000.

## Windows production-like deployment

For a single Windows host without containers:

```powershell
.\scripts\windows\build_production.bat
.\start_production.bat
```

This path is useful for acceptance testing. Containers behind a managed TLS
load balancer are preferred for repeatable server deployments.

## Capacity baseline

Measurements were taken locally on an 8-core Intel Core Ultra 7 258V system
with 31.5 GB RAM, using one Agent worker and the production frontend gateway.

| Workload | Concurrency | Success | Throughput | p95 latency |
| --- | ---: | ---: | ---: | ---: |
| Static HTML | 50 | 100% | 448 req/s | 142 ms |
| Static HTML | 200 | 100% | 383 req/s | 689 ms |
| Lightweight API `/api/state` | 50 | 100% | 342 req/s | 182 ms |
| Lightweight API `/api/state` | 100 | 100% | 318 req/s | 444 ms |
| Lightweight API `/api/state` | 200 | 100% | 275 req/s | 1.02 s |
| GEE default map before thread-pool fix | 5 | 100% | 1.55 req/s | 4.50 s |
| GEE default map after thread-pool fix | 5 | 100% | 4.10 req/s | 1.96 s |
| GEE default map, thread pool + 5-operation guard | 10 | 100% | 3.88 req/s | 2.79 s |

The recommended single-instance operating envelope is:

- up to 50 simultaneously active users for lightweight navigation/API work;
- no more than 5 simultaneous GEE/analysis operations per Agent process;
- 100–200 online users is reasonable only when most are reading or idle, not
  all starting analysis at once;
- LLM/agent concurrency must also fit the OpenAI account's model-specific RPM,
  TPM, and concurrent request limits.

These are baseline measurements, not an SLA. Repeat the load test from a
separate machine in the production region with representative AOIs and prompts.

## Hardware baseline

| Target | CPU | RAM | Disk | Network | Intended load |
| --- | ---: | ---: | ---: | ---: | --- |
| Acceptance / small pilot | 4 vCPU | 8 GB | 50 GB SSD | 100 Mbps | 10–20 active users, 2–3 analyses at once |
| Recommended first production | 8 vCPU | 16 GB | 100 GB SSD | 500 Mbps+ | up to 50 active users, 5 analyses at once |
| HA / over 50 active users | 2 x 8 vCPU | 2 x 16 GB | 100 GB SSD each | 1 Gbps + CDN | requires shared state and load balancing |

The measured steady process footprint was about 350 MB total, but raster
downloads, large GeoJSON payloads, builds, logs, and temporary files require
substantial headroom. CPU and external API latency, rather than idle memory,
were the first observed constraints.

## Go-live blockers and follow-up

1. Add user authentication and authorization. The current APIs are publicly
   callable if an internal service is accidentally exposed; the same-origin
   gateway is not access control.
2. Terminate HTTPS at a managed load balancer/reverse proxy and store secrets in
   a server-side secret manager rather than a long-lived `.env` file.
3. Move LangGraph checkpoints and business-layer/session state to shared
   storage before enabling multiple Agent workers or replicas.
4. Add production metrics and alerts for p95 latency, HTTP 429/5xx, GEE quota,
   OpenAI rate-limit errors, queue saturation, CPU, memory, and disk.
5. Put static assets behind a CDN. The current main JavaScript bundle is about
   1.14 MB gzip and benefits materially from edge caching.
6. Run realistic LLM load tests in a staging project with a dedicated budget;
   the included local test intentionally avoids bulk paid API calls.
