# SatGPT

**English** | [简体中文](README.zh-CN.md)

SatGPT is a remote sensing analysis application powered by Google Earth Engine (GEE). It combines an interactive map, static data layers, and an agent that can query datasets, run analyses, and present results as map layers and charts.

The application has two modes: **Static layers (Basic)** and **Intelligent analysis (Agent)**. Both share one persistent Mapbox map and the current view, while keeping their analysis state separate.

## Features

| Area | Capabilities |
| --- | --- |
| Basic analysis | Map exploration, flood-related layers, grid and drawn-area selection, and basic question answering. |
| Agent analysis | GEE dataset search, coverage and statistics queries, image previews, and interactive result layers through the DeepSeek Harness SDK. |
| Conversations | Streamed answers, an ordered run timeline, saved conversation history, switching during a run, and stopping running or queued tasks. |
| Result layers | Per-conversation layer isolation, thumbnails, observation dates, sources, legends, visibility controls, location, and removal. |
| Charts | Interactive ECharts charts rendered after a response finishes, with configuration copying and PNG export. |
| Shared workspace | A persistent map across mode switches, resizable chat and map panels, narrow-screen views, a scale bar, and map screenshots. |

Grid selection resolves the clicked feature's `FID` against the original GeoJSON. The displayed selection and analysis request use the same complete geometry, independently of map zoom and tile clipping.

## Architecture

| Component | Technology and role |
| --- | --- |
| `frontend/` | React, Vite, Mapbox GL JS, Streamdown, and ECharts; shared map and Basic/Agent interfaces. |
| `agent/` | Python FastAPI backend for Basic analysis and question answering. |
| `harness/` | Python FastAPI backend, DeepSeek Harness SDK, GEE tool plugin, Python worker, and server-sent events (SSE). |
| `scripts/` | Windows setup and startup scripts, plus Docker Compose deployment. |

The current baseline does not register experimental Skills. Agent tasks execute in one queue; switching conversations leaves the original task running in the background and saves its results to the original conversation.

## Prerequisites

- **Python 3.12**. Check that `python --version` reports 3.12.
- **Node.js 22.12 or later** and npm. The setup script also accepts the supported Node.js 20.19+ release line.
- A Mapbox browser public token with access to the configured map style.
- Model API keys for Basic and the selected Agent provider.
- A Google Cloud project registered for Earth Engine with the Earth Engine API enabled, and **service account JSON credentials** authorized to access the project and required GEE data.

Run the Windows commands below from PowerShell in the repository root.

## Quick start

### 1. Clone the release branch

```powershell
git clone --branch pro2.0 --single-branch https://github.com/BarberHu/SatGPT-app.git
cd SatGPT-app
```

### 2. Create the configuration file

```powershell
Copy-Item .env.example .env
```

Place the service account JSON at `.private-key.json` in the repository root, or set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path. Complete the root `.env` before starting the application.

### 3. Configure credentials and models

Set the shared GEE and map configuration, followed by the separate Basic and Agent model settings:

```dotenv
GOOGLE_APPLICATION_CREDENTIALS=.private-key.json
GEE_PROJECT_ID=your-google-cloud-project-id

REACT_APP_MAPBOX_ACCESS_TOKEN=your-mapbox-public-token
REACT_APP_MAPBOX_STYLE_URL=mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp

OPENAI_API_KEY=your-basic-model-key
OPENAI_API_BASE=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini

DSH_PROVIDER=deepseek-official
DSH_MODEL=deepseek-v4-flash
DEEPSEEK_API_KEY=your-deepseek-key
```

The model names above match the repository defaults. Confirm that the selected provider supports your chosen model. To use AIHubMix for the Agent, replace the Agent settings with:

```dotenv
DSH_PROVIDER=aihubmix
DSH_MODEL=your-model-id
AIHUBMIX_API_KEY=your-aihubmix-key
AIHUBMIX_BASE_URL=https://aihubmix.com/v1
```

Basic and Agent model settings are independent. `OPENAI_API_KEY` is used for Basic question answering, location resolution, and dataset recommendations. The Agent requires only the selected provider's key; leave the unused provider's key empty. Use a browser public Mapbox token, not a secret token.

For optional reasoning, output-length, port, and network settings, see [`.env.example`](.env.example).

### 4. Install, validate, and start

```powershell
.\scripts\windows\satgpt.bat setup
.\harness\.venv\Scripts\python.exe satgpt_config.py check
.\scripts\windows\satgpt.bat dev
```

Setup creates `basic-venv/` and `harness/.venv/`, installs Python and frontend dependencies, and copies the configuration template if `.env` does not exist. Development mode supports frontend hot updates. Configuration validation checks local settings; it does not prove successful model or GEE authentication.

Open **[http://127.0.0.1:3000/](http://127.0.0.1:3000/)**.

| Service | Default address |
| --- | --- |
| Frontend | [http://127.0.0.1:3000](http://127.0.0.1:3000) |
| Basic API | [http://127.0.0.1:8000](http://127.0.0.1:8000) |
| Harness Agent API | [http://127.0.0.1:8001](http://127.0.0.1:8001) |

`FRONTEND_PORT`, `AGENT_PORT`, and `HARNESS_PORT` come from the root `.env` and must be different. Development and production use the same configured ports. Stop the existing services before switching startup modes. To stop the Windows services, press `Ctrl+C` in each of the three service windows, then close the windows.

## Using SatGPT

1. Start in **Static layers** to explore the map, select a grid or draw an area, and use Basic analysis. Grid selection loads data for the complete original grid cell.
2. Switch to **Intelligent analysis** to ask the Agent about the current map area or another explicitly named location. Follow the streamed answer and run timeline.
3. Use conversation history to open another chat or start a new one during a run. Returning to a running chat restores its task subscription. New tasks remain subject to the shared execution queue.
4. Use the square **Stop response** button to cancel a running or queued task. The task is recorded as **Stopped**, its runtime is closed when applicable, and you can send a follow-up. Stopping does not require text in the input or an available map.
5. Inspect result layer cards for thumbnails, observation dates, sources, and legends. Toggle visibility, inspect details, locate a layer, or remove it. Unknown dates are marked explicitly; a failed thumbnail does not prevent use of the interactive layer.
6. Request a chart when useful. Valid lowercase `echarts` JSON blocks render after the answer finishes; chart options remain available for copying, and charts can be exported as PNG. Invalid options show their source and an error. The development-only preview is available at [http://127.0.0.1:3000/?review=echarts](http://127.0.0.1:3000/?review=echarts).
7. Use the screenshot button to save the current shared map view once the map is ready. On narrow screens, open the Agent map view first.

Mode switches preserve the map and camera without reloading the basemap or automatically locating a result. Agent layers are isolated by conversation. The scale bar follows map movement, zoom, and panel resizing, switching between meters and kilometers.

The interface uses English, `en-US` dates and numbers, and `m` / `km` distances. Basemap labels prefer English where available and retain the original name otherwise. Basic summaries, Agent answers, layer names, and legends default to English, while explicit requests for another language are respected. Existing messages, layer metadata, and user input are not automatically translated. **Settings** is currently a placeholder and does not accept or store personal API keys.

## Configuration and local data

- The root `.env` is the single configuration entry point, and [`.env.example`](.env.example) is its template. Precedence is **process environment > root `.env` > application defaults**. Explicit empty values also take precedence and fail validation when required.
- Frontend environment files, mode-specific `.env.*` files, and configuration JSON from other projects are not read. Values do not expand `${VAR}`; use single quotes for values containing `#`, spaces, or `$`.
- Relative credential paths resolve from the repository root regardless of the startup directory.
- Model keys and service account JSON remain on the backend. Git and Docker builds exclude real configuration. Vite exposes only the two explicitly selected `REACT_APP_MAPBOX_*` public settings.
- Agent conversations, session data, and previews are stored in `harness/state/`. Back up this directory to preserve history.

## Production deployment

For a local Windows production build and startup:

```powershell
.\scripts\windows\satgpt.bat deploy
```

Alternatively, run `satgpt.bat build` and `satgpt.bat prod` separately through the same script path.

For Docker Engine with Compose v2, configure the root `.env` and credentials first, then run from the repository root:

```powershell
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml config --quiet
docker compose --project-name satgpt --project-directory . --env-file .env -f scripts/docker/compose.harness.yml up -d --build
```

Keep `--project-directory .` so build and credential paths resolve correctly. Only the frontend port is published on the host loopback address; backends remain on the container network. The `harness_state` volume stores conversation data.

| Changed setting | Required action |
| --- | --- |
| Basic model | Restart the Basic API. |
| Agent model | Restart the Harness API, including its SDK and worker processes. |
| GEE configuration or credentials | Restart both APIs. |
| Service ports | Restart the affected APIs and frontend/gateway. |
| Mapbox configuration | Restart Vite in development; rebuild the frontend and restart the gateway in production, or rebuild the Docker frontend image. |

Built browser assets do not read runtime `.env` values. Use `config --quiet` rather than printing expanded Compose configuration, which can contain secrets. See [PRODUCTION.md](PRODUCTION.md) for deployment details in Chinese.

The application currently targets trusted users. Public hosting requires authentication, user isolation, TLS, GEE/model limits, execution isolation for generated code, and auditing. Keep backend ports private. Multiple replicas require replacing local-file conversation storage.

## Health checks and troubleshooting

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
Invoke-RestMethod http://127.0.0.1:8001/health
```

The production gateway's `/readyz` checks connectivity to both APIs, and `/health` proxies the Basic health endpoint.

| Symptom | Check |
| --- | --- |
| Blank map | Mapbox public token, style access, and whether frontend configuration changes have been applied. |
| GEE authentication fails | Credential path, project ID, API registration/enabling, service account permissions, and network access to Google services. |
| Model returns 401 | The selected provider and its matching API key. |
| Port already in use | Stop previously started services before restarting. |
| Result tiles fail after a long idle period | GEE map links are temporary; rerun the query to obtain a usable link. |
| Stop button or conversation switching still behaves as before | Restart the Harness backend and refresh the page after updating the code. |

`model_key_configured` and `gee_project_configured` report configuration presence only. `model_authentication=not_checked` and Harness `gee_authentication=not_checked` mean no remote authentication check has run. Basic `gee_initialized` reports initialization status. Use an actual query and the Agent's `gee_status` tool to verify remote access.

## Project layout

```text
frontend/             React frontend, shared map, Basic/Agent views, and charts
agent/                Basic FastAPI service
harness/app/          Agent API, controller, SDK adapter, and Python worker
harness/integrations/ GEE tools and streaming integration
scripts/windows/      Windows setup, development, and production commands
scripts/docker/       Docker Compose configuration
satgpt_config.py      Shared configuration validation and API launcher
.env.example          Root configuration template
```

## Further documentation

- [Production deployment and public-hosting requirements](PRODUCTION.md) (Chinese).
- [Deployment scripts](scripts/README.md) (Chinese).
- [Shared map architecture](frontend/src/map/README.md) (English).
- [Chart integration and third-party attribution](frontend/src/harness/echarts/README.md) (English).

The chart integration includes third-party validator code with its [license](frontend/src/harness/echarts/vendor/LICENSE) and [notice](frontend/src/harness/echarts/vendor/NOTICE). Keep these attribution files when redistributing that code.
