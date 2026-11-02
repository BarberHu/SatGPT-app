@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\harness\.venv\Scripts\python.exe"
set "BASIC_PYTHON=%ROOT_DIR%\basic-venv\Scripts\python.exe"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)
if not exist "%BASIC_PYTHON%" (echo Missing Basic API environment. Run setup first. & exit /b 1)
if not defined DSH_LOCAL_CONFIG_FILE if exist "%ROOT_DIR%\..\GEE_harness\state\local-config.json" for %%I in ("%ROOT_DIR%\..\GEE_harness\state\local-config.json") do set "DSH_LOCAL_CONFIG_FILE=%%~fI"

start "SatGPT Basic API" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%BASIC_PYTHON%" -m uvicorn server:app --host 127.0.0.1 --port 8000
start "SatGPT Harness" cmd /k cd /d "%ROOT_DIR%\harness" ^&^& "%PYTHON%" -m app
start "SatGPT Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm run dev

echo Development services started. Ports are configured in .env.
exit /b 0
