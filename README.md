# SatGPT - Flood Analysis Platform

SatGPT is a flood event analysis platform that combines a React map UI, a CopilotKit runtime, a FastAPI backend, LangGraph, Google Earth Engine, and OpenAI/Tavily integrations.

## Architecture

<<<<<<< codex/layeManagement-user-changes
```text
React Frontend :3000
  |-- /api, /health, /agent --> FastAPI Agent :8000
  `-- /copilotkit ---------> CopilotKit Runtime :5000 --> FastAPI Agent :8000/agent
=======
## 🎬 Demo

https://github.com/user-attachments/assets/87be7cf0-fb08-4b6c-b1f1-3ef6008f5eb5

## 📋 Overview

- **🤖 AI Agent**: Conversational flood queries powered by LangGraph + CopilotKit
- **🛰️ Satellite Imagery**: Sentinel-1/2 data via Google Earth Engine
- **🗺️ Interactive Maps**: Multi-layer visualization with Mapbox
- **📊 Impact Assessment**: Population, urban area, and land cover analysis

## 🏗️ Project Structure

```
SatGPT-app/
├── app.py                 # Flask backend (port 5001)
├── agent/                 # AI Agent backend (FastAPI + LangGraph)
│   ├── server.py          # FastAPI server (port 8000)
│   ├── flood_agent.py     # LangGraph agent
│   ├── gee_service.py     # Google Earth Engine service
│   ├── tools.py           # Agent tools (Tavily search)
│   ├── prompts.py         # System prompts
│   └── state.py           # State definitions
├── frontend/              # React frontend (port 3000)
│   └── src/
│       ├── components/    # UI components
│       ├── context/       # React context
│       ├── hooks/         # Custom hooks
│       └── services/      # API services
├── runtime/               # CopilotKit runtime (port 5000)
│   └── server.ts          # Express + CopilotKit
├── static/                # Static assets
├── templates/             # HTML templates
├── start_all.bat          # Compatibility wrapper to scripts/windows/start_windows.bat
└── scripts/               # Windows setup/start scripts
>>>>>>> experiment/layeManagement_develop
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

## Requirements

<<<<<<< codex/layeManagement-user-changes
- Python 3.12.10
- Node.js 22.16.0
- npm from Node.js 22.16.0
- OpenAI API key
- Tavily API key
- Google Earth Engine credentials
- Mapbox access token
=======
```bash
# 1. Python environment
python -m venv flood-venv
.\flood-venv\Scripts\activate        # Windows
pip install -r requirements.txt
>>>>>>> experiment/layeManagement_develop

## Setup

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

