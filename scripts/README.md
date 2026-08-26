# Deployment Scripts

The scripts are separated by execution environment. This directory contains
only local Windows operations, formal Docker deployment, and pre-release
capacity validation.

## Directory layout

```text
scripts/
  windows/                Windows local testing and production-like deployment
    satgpt.bat             Single Windows command entry point
    setup_windows.bat      Validate and install the local toolchain
    start_windows.bat      Start all development services
    build_production.bat   Build optimized frontend and Runtime assets
    start_production.bat   Start an existing production-like build
    helpers/               Frontend public environment synchronization
  docker/                 Formal server deployment
    compose.yml            Agent + Runtime + Nginx frontend stack
  performance/            Cross-platform deployment capacity validation
    load_test.py
    payloads/state.json
```

The old native Linux multi-process launchers were removed. Linux servers use
Docker Compose so their Python, Node.js, Nginx, networking, and restart policy
are defined by the same deployment configuration.

## Windows local workflow

Run these commands from the repository root:

| Command | Purpose |
| --- | --- |
| `scripts\windows\satgpt.bat setup` | Validate prerequisites and install dependencies |
| `scripts\windows\satgpt.bat dev` | Start Agent, Runtime, and the CRA development server |
| `scripts\windows\satgpt.bat build` | Build optimized production assets |
| `scripts\windows\satgpt.bat prod` | Start an existing production-like build |
| `scripts\windows\satgpt.bat deploy` | Build and start the production-like stack |

The Windows production-like path uses the Node gateway and is intended for
local acceptance testing or a Windows-only host.

## Docker server workflow

Run the platform-independent Docker Compose commands documented in
[`docker/README.md`](docker/README.md). Docker is the canonical formal server
deployment path and uses the Nginx frontend as the only public gateway.

## Configuration and ports

The repository-root `.env` is the only editable configuration source. The
default service chain is:

```text
Frontend gateway :3000
  |-- /api, /health, /agent -> FastAPI Agent :8000
  `-- /copilotkit            -> CopilotKit Runtime :5000
```

Ports 5000 and 8000 remain internal in Docker. Only `FRONTEND_PORT` is
published. Presentation tooling lives under `experiments/presentations` and is
not part of deployment.
