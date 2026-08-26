@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\flood-venv\Scripts\python.exe"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)
if not exist "%ROOT_DIR%\frontend\build\index.html" (echo Missing frontend build. Run build first. & exit /b 1)
if not exist "%ROOT_DIR%\runtime\dist\server.js" (echo Missing runtime build. Run build first. & exit /b 1)

start "SatGPT Agent Production" /min cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON%" server.py
start "SatGPT Runtime Production" /min cmd /k cd /d "%ROOT_DIR%\runtime" ^&^& call npm run start:prod
start "SatGPT Frontend Production" /min cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm run start:prod

echo Production services started. Open the frontend port configured in .env.
exit /b 0
