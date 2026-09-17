# SatGPT - Flood Analysis Platform

SatGPT is a flood event analysis platform that combines a React map UI, a CopilotKit runtime, a FastAPI backend, LangGraph, Google Earth Engine, and OpenAI integrations.

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
scripts/               Deployment setup/build/start/validation scripts
  windows/             Windows local test and production-like deployment
  docker/              Docker formal server deployment
  performance/         Pre-release capacity validation
experiments/            Non-deployment prototypes and presentation tools
requirements.txt       Root pointer to agent/requirements.txt
```

## Requirements

- Python 3.12.10
- Node.js 22.16.0
- npm from Node.js 22.16.0
- OpenAI API key
- Tavily API key
- Google Earth Engine credentials
- Mapbox access token

## Deployment and Startup

Run all commands from a PowerShell or terminal window opened in the project root. Do not double-click the scripts directly.

### Windows Local Deployment

1. Right-click an empty area in the project folder, select **Open in Terminal**, and install the runtime environment:

```powershell
.\scripts\windows\satgpt.bat setup
```

2. Open `.env` in the project root and complete the following settings:

```env
OPENAI_API_KEY=your-openai-api-key
GOOGLE_APPLICATION_CREDENTIALS=.private-key.json
GEE_PROJECT_ID=your-google-cloud-project-id
REACT_APP_MAPBOX_ACCESS_TOKEN=your-mapbox-token
REACT_APP_MAPBOX_STYLE_URL=your-mapbox-style-url
```

3. Build and start the production version:

```powershell
.\scripts\windows\satgpt.bat deploy
```

4. After the services start, open http://localhost:3000 on this computer or `http://MACHINE_IP:3000` from the local network.

To start the existing production build again later, run:

```powershell
.\scripts\windows\satgpt.bat prod
```

After changing code or frontend environment variables, run `deploy` again.

5. To use development mode, run:

```powershell
.\scripts\windows\satgpt.bat dev
```

### Docker Production Server Deployment

1. Install Docker and Docker Compose on the server, then upload the project to the server.
2. Prepare `.env` and `.private-key.json` in the project root.
3. Open a terminal in the project root and run:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml up -d --build
```

4. After deployment, open `http://SERVER_IP:3000` in a browser. If you changed
   `FRONTEND_PORT`, replace 3000 with the configured port.

Check the service status and logs:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml ps
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml logs --tail 100 -f
```

Stop the project:

```bash
docker compose --project-name satgpt --env-file .env --file scripts/docker/compose.yml down
```

Docker publishes only the frontend port. Agent port 8000 and Runtime port 5000 remain inside the container network.
See [PRODUCTION.md](PRODUCTION.md) for additional go-live configuration and capacity guidance.

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

If a service reports a port conflict in its terminal window, stop the process using that port or change `FRONTEND_PORT`, `RUNTIME_PORT`, or `AGENT_PORT` in the repository root `.env`.

If GEE reports `initialized=false`, check `GOOGLE_APPLICATION_CREDENTIALS` and `GEE_PROJECT_ID` in `.env`.

