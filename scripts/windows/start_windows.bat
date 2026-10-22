@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\flood-venv\Scripts\python.exe"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%helpers\sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 exit /b 1

start "SatGPT Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON%" server.py
start "SatGPT Runtime" cmd /k cd /d "%ROOT_DIR%\runtime" ^&^& call npm start
start "SatGPT Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm start

echo Development services started. Ports are configured in .env.
exit /b 0
