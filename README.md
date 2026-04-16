# 🌊 SatGPT - Flood Analysis Platform

An intelligent flood event analysis platform integrating AI-powered chatbot, satellite remote sensing imagery, and interactive mapping capabilities.

> **Forked from [sas-unescap/SatGPT-app](https://github.com/sas-unescap/SatGPT-app)** and extended with LangGraph AI Agent, CopilotKit integration, and advanced flood detection.

## 🎬 Demo

https://github.com/user-attachments/assets/ad1d281f-39ff-4202-bfe2-ebb5150994da

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
├── start_all.bat          # One-click startup (Windows)
└── stop_all.bat           # Stop all services
```

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- Python ≥ 3.10
- API Keys: OpenAI, Tavily, Mapbox, GEE Service Account

### Installation

```bash
# 1. Python environment
python -m venv flood-venv
.\flood-venv\Scripts\activate        # Windows
pip install -r requirements.txt
pip install -r agent/requirements.txt

# 2. Frontend dependencies
cd frontend && npm install && cd ..

# 3. Runtime dependencies
cd runtime && npm install && cd ..
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```env
OPENAI_API_KEY=your-openai-key
TAVILY_API_KEY=your-tavily-key
GOOGLE_APPLICATION_CREDENTIALS=./your-service-account.json
GEE_PROJECT_ID=your-gcp-project
REACT_APP_MAPBOX_ACCESS_KEY=your-mapbox-token
```

`.env.example` is the version-controlled template.
Your local `.env` is the actual runtime configuration file.
When you use the Windows scripts, public frontend variables are synced from
the root `.env` into `frontend/.env.local` automatically.
Flask / Agent / Runtime / Frontend ports are also configured from the root `.env`.

### Start Services

```bash
# One-click start (Windows)
.\start_all.bat

# Or start individually:
# Terminal 1: Flask Backend (port 5001)
python app.py

# Terminal 2: FastAPI Agent (port 8000)
cd agent && python server.py

# Terminal 3: CopilotKit Runtime (port 5000)
cd runtime && npm run dev

# Terminal 4: React Frontend (port 3000)
cd frontend && npm start
```

Open http://localhost:3000

## 🎯 Usage

1. Open the app and switch to **"Agent"** mode
2. Enter a flood query, e.g., *"Analyze the 2024 Chiang Mai flood event"*
3. Confirm the AI-extracted date information
4. View satellite imagery and flood detection results on the map
5. Download the analysis report

## 📡 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/copilotkit` | POST | CopilotKit agent entry |
| `/api/flood-images` | POST | Get Sentinel flood imagery |
| `/api/flood-impact` | POST | Get impact assessment |
| `/api/gee-status` | GET | GEE service status |
| `/api/geocode` | GET | Geocode location |

## 🔧 Architecture

```
React Frontend (3000) → CopilotKit Runtime (5000) → FastAPI Agent (8000)
                                                         ├── LangGraph Agent
                                                         ├── GEE Service
                                                         └── Tavily Search
```

## 📄 License

MIT License

## 👤 Author

**Wang Yang**

---

*Built with React, CopilotKit, LangGraph, Google Earth Engine, and Mapbox*
