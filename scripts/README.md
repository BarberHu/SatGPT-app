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
  - Fail fast when Agent / Runtime / Frontend ports are already occupied, and print the owning PID / command.
  - Start FastAPI agent on `8000`.
  - Start CopilotKit runtime on `5000`.
  - Start React frontend on `3000`.

- `scripts\windows\generate_qrcode.ps1`
  - Generate a PNG QR code from a URL.
  - Uses a public QR code generation endpoint and saves the result locally.
  - Example:

    ```powershell
    .\scripts\windows\generate_qrcode.bat `
      -Url "https://bit.ly/SatGPT_UI_Test" `
      -OutFile "outputs\satgpt_ui_test_qrcode.png"
    ```

  - Optional parameters:
    - `-Size 1024` for image size in pixels.
    - `-Margin 20` for QR code margin.
  - The `.bat` wrapper runs the PowerShell script with a local execution-policy bypass, so you do not need to change the system-wide PowerShell policy.

## Port conflicts

The local development chain is:

`React frontend (3000) -> CopilotKit runtime (5000) -> FastAPI agent (8000)`

If one of these ports is already occupied, do not keep launching another copy of the app. Stop the owning process first, or change the matching port in the repository root `.env`:

- `FRONTEND_PORT` for React
- `RUNTIME_PORT` for CopilotKit runtime
- `AGENT_PORT` for FastAPI agent

After changing ports, rerun `scripts\windows\start_windows.bat` so `frontend\.env.local` is regenerated with the correct proxy targets.

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

## Localhost fallback

For same-machine development, use localhost URLs even if your LAN IP changes:

- `http://localhost:3000` for the React frontend
- `http://localhost:5000` for the CopilotKit runtime
- `http://localhost:8000` for the FastAPI agent

`SATGPT_PUBLIC_HOST` is only needed when sharing the app from another device on the network. Local service-to-service calls use localhost directly, so a stale LAN IP in `SATGPT_PUBLIC_HOST` will not break localhost access.

## Manual startup note

If you start services manually, make sure Python points to the project virtual environment first, for example:

`SatGPT-app\flood-venv\Scripts\python.exe SatGPT-app\agent\server.py`

Using a global Python interpreter may cause dependency/version drift and unstable local behavior.
