@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\harness\.venv\Scripts\python.exe"
set "FRONTEND_PORT=3001"
set "FRONTEND_HOST=127.0.0.1"
set "SATGPT_BASE_PATH=/"
set "SATGPT_ALLOW_REMOTE_HARNESS=false"
set "AGENT_PORT=8001"
set "AGENT_HOST=127.0.0.1"
set "SATGPT_SERVICE_HOST=%AGENT_HOST%"
set "SATGPT_PUBLIC_ORIGIN=http://%FRONTEND_HOST%:%FRONTEND_PORT%"
set "SATGPT_COOKIE_SECURE=false"
set "SATGPT_HARNESS_STATE_DIR=%ROOT_DIR%\harness\state\dev-multiuser"
set "SATGPT_DEV_TURN_USAGE=1"

if not "%~1"=="" if /I not "%~1"=="--frontend-only" (
    echo Usage: start_windows.bat [--frontend-only]
    exit /b 2
)
if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if /I "%~1"=="--frontend-only" goto :frontend
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)

"%PYTHON%" "%ROOT_DIR%\satgpt_config.py" check || exit /b 1
start "SatGPT Backend Development" /min cmd /k cd /d "%ROOT_DIR%" ^&^& "%PYTHON%" "%ROOT_DIR%\satgpt_config.py" backend
if errorlevel 1 exit /b %ERRORLEVEL%
echo Development backend starting on port %AGENT_PORT%.

:frontend
start "SatGPT Frontend Development" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm run dev
if errorlevel 1 exit /b %ERRORLEVEL%

echo Development frontend starting on port %FRONTEND_PORT%.
exit /b 0
