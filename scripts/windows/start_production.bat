@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "HELPERS_DIR=%SCRIPT_DIR%helpers\"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON_EXE=%ROOT_DIR%\flood-venv\Scripts\python.exe"

echo ==========================================
echo       SatGPT Production Startup
echo ==========================================
echo Root: %ROOT_DIR%
echo.

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Python virtual environment is missing.
    exit /b 1
)
if not exist "%ROOT_DIR%\frontend\build\index.html" (
    echo [ERROR] Frontend production build is missing. Run build_production.bat first.
    exit /b 1
)
if not exist "%ROOT_DIR%\runtime\dist\server.js" (
    echo [ERROR] Runtime production build is missing. Run build_production.bat first.
    exit /b 1
)

for /f "usebackq delims=" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPERS_DIR%load_launch_env.ps1" -RootDir "%ROOT_DIR%"`) do set "%%A"
if errorlevel 1 exit /b 1

powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPERS_DIR%check_ports_available.ps1" -Ports "%AGENT_PORT%,%RUNTIME_PORT%,%FRONTEND_PORT%"
if errorlevel 1 exit /b 1

echo Agent workers: %AGENT_WORKERS%
echo Frontend mode: optimized static production build
echo.

start "SatGPT Agent Production" /min cmd /c cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" -m uvicorn server:app --host %AGENT_HOST% --port %AGENT_PORT% --workers %AGENT_WORKERS% --proxy-headers --forwarded-allow-ips "%FORWARDED_ALLOW_IPS%"
start "SatGPT Runtime Production" /min cmd /c cd /d "%ROOT_DIR%\runtime" ^&^& call npm run start:prod
start "SatGPT Frontend Production" /min cmd /c cd /d "%ROOT_DIR%\frontend" ^&^& call npm run start:prod

echo Production services dispatched.
echo Local application: http://localhost:%FRONTEND_PORT%
echo Readiness:         http://localhost:%FRONTEND_PORT%/readyz
echo LAN users may use this server's current IP or DNS name with port %FRONTEND_PORT%.
exit /b 0
