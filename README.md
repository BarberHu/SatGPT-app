# SatGPT - Flood Analysis Platform

SatGPT is a flood event analysis platform that combines a React map UI, a CopilotKit runtime, a FastAPI backend, LangGraph, Google Earth Engine, and OpenAI/Tavily integrations.

## Demo

https://github.com/user-attachments/assets/61a1a09f-c380-4bd8-9f7d-e1dfb38748d1

## Architecture

```text
React Frontend :3000
  |-- /api, /health, /agent --> FastAPI Agent :8000
  `-- /copilotkit ---------> CopilotKit Runtime :5000 --> FastAPI Agent :8000/agent
```

## Project Structure

```text
agent/                 FastAPI + LangGraph backend
frontend/              React frontend
runtime/               CopilotKit runtime
scripts/windows/       Windows setup/start scripts
start_all.bat          Root wrapper for scripts/windows/start_windows.bat
requirements.txt       Root pointer to agent/requirements.txt
```

## Prerequisites

- Python 3.12.10
- Node.js 22.16.0
- npm from Node.js 22.16.0
- Any of the following package managers:
  - npm (default)
  - pnpm
  - yarn
  - bun
- OpenAI API key (for the LangGraph agent)
- Tavily API key (for the Web information retrival)
- Google Earth Engine credentials (GEE service account credentials)
- Mapbox access token (for the base Map)

## Getting Started

1. Install dependencies using your preferred package 

```
# Using npm (default)
npm install

# Using pnpm
pnpm install

# Using yarn
yarn install

# Using bun
bun install
```
2. Install Python dependencies for the LangGraph agent:

```
# Using npm (default)
npm run install:agent

# Using pnpm
pnpm install:agent

# Using yarn
yarn install:agent

# Using bun
bun run install:agent
```

manager:
```powershell
.\scripts\windows\setup_windows.bat
```

The setup script creates `flood-venv`, installs the FastAPI backend dependencies, installs frontend/runtime npm dependencies, creates `.env` from `.env.example` when missing, and syncs public frontend variables into `frontend\.env.local`.

Fill in `.env` after setup:

```env
OPENAI_API_KEY=your-openai-key
TAVILY_API_KEY=your-tavily-key
GOOGLE_APPLICATION_CREDENTIALS=.\your-service-account.json
GEE_PROJECT_ID=your-gcp-project
REACT_APP_MAPBOX_ACCESS_KEY=your-mapbox-token
```

## Start

```powershell
.\start_all.bat
```

This starts:

```text
FastAPI Agent:      http://localhost:8000
CopilotKit Runtime: http://localhost:5000
React Frontend:     http://localhost:3000
```

Open http://localhost:3000.

## API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | FastAPI health check |
| `/agent` | POST | AG-UI agent endpoint |
| `/api/maps/default` | GET | Default water map |
| `/api/maps/historical` | POST | Historical flood data |
| `/api/maps/flood-hotspot` | POST | Flood hotspot data |
| `/api/maps/unsupervised` | POST | Unsupervised classification |
| `/api/chat` | POST | Ask-mode chat |
| `/api/scripts/gee` | POST | Generate GEE script |
| `/api/scripts/pdf` | GET | Download generated script PDF |
| `/api/flood-images` | POST | Get Sentinel flood imagery |
| `/api/flood-impact` | POST | Get impact assessment |
| `/api/gee-status` | GET | GEE service status |
| `/api/location-search` | POST | Search and resolve locations |

## Troubleshooting

If startup reports a port conflict, stop the printed PID first or change `FRONTEND_PORT`, `RUNTIME_PORT`, or `AGENT_PORT` in the repository root `.env`.

If GEE reports `initialized=false`, check `GOOGLE_APPLICATION_CREDENTIALS` and `GEE_PROJECT_ID` in `.env`.

