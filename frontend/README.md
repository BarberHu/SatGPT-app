# SatGPT Frontend

React frontend for the SatGPT flood analysis platform.

The current local development stack is:

```text
React Frontend :3000
  -> FastAPI Agent :8000 for /api, /health, and /agent
  -> CopilotKit Runtime :5000 for /copilotkit
```

From the repository root, use the Windows launcher for normal development:

```powershell
..\scripts\windows\satgpt.bat setup
..\scripts\windows\satgpt.bat dev
```

When running only the frontend:

```powershell
npm install
npm start
```

The frontend reads public variables from `frontend\.env.local`, which is generated from the repository root `.env` by `scripts\windows\helpers\sync_frontend_env.ps1`.
Browser API calls always use same-origin `/api`, `/health`, `/agent`, and
`/copilotkit` paths, so separate frontend API URL variables are not needed.

## API Routes

The frontend calls the FastAPI backend through these current routes:

| Endpoint | Method | Description |
| --- | --- | --- |
| `/health` | GET | Backend health check |
| `/api/maps/default` | GET | Default water map |
| `/api/maps/historical` | POST | Historical flood data |
| `/api/maps/flood-hotspot` | POST | Flood hotspot data |
| `/api/maps/unsupervised` | POST | Unsupervised classification |
| `/api/chat` | POST | Ask-mode chat |
| `/api/scripts/gee` | POST | Generate GEE script |
| `/api/scripts/pdf` | GET | Download generated script PDF |
| `/api/agent-raster-layers` | POST | Agent raster layer payload |

