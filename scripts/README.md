# Scripts

## Windows

- `scripts\windows\setup_windows.bat`
  - Create the shared Python virtual environment.
  - Pin `setuptools<81` for legacy `pkg_resources` compatibility.
  - Install Python dependencies from `requirements.txt` and `agent\requirements.txt`.
  - Install `frontend` and `runtime` Node dependencies.
  - Create `.env` from `.env.example` when missing.
  - Sync public `REACT_APP_*` variables from the root `.env` into `frontend\.env.local`.

- `scripts\windows\start_windows.bat`
  - Treat the repository root `.env` as the actual runtime config file.
  - Read Agent / Runtime / Frontend ports from the root `.env`.
  - Sync public `REACT_APP_*` variables from the root `.env` into `frontend\.env.local`.
  - Start FastAPI agent on `8000`.
  - Start CopilotKit runtime on `5000`.
  - Start React frontend on `3000`.

## Recommended onboarding flow

1. Run `scripts\windows\setup_windows.bat`
2. Copy `.env.example` to `.env`, then fill in the repository root `.env`
3. Run `scripts\windows\start_windows.bat`

## Optional proxy

If Google Earth Engine or other services require a proxy, set:

`set SATGPT_HTTP_PROXY=http://127.0.0.1:7890`

before launching `start_windows.bat`.

When proxy is enabled, local service-to-service calls should bypass the proxy:

`set NO_PROXY=localhost,127.0.0.1,::1`

`start_windows.bat` now sets this automatically.

## Manual startup note

If you start services manually, make sure Python points to the project virtual environment first, for example:

`SatGPT-app\flood-venv\Scripts\python.exe SatGPT-app\agent\server.py`

Using a global Python interpreter may cause dependency/version drift and unstable local behavior.
