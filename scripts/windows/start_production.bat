@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\harness\.venv\Scripts\python.exe"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)
if not exist "%ROOT_DIR%\frontend\build\index.html" (echo Missing frontend build. Run build first. & exit /b 1)
"%PYTHON%" "%ROOT_DIR%\satgpt_config.py" check || exit /b 1
start "SatGPT Backend Production" /min cmd /k cd /d "%ROOT_DIR%" ^&^& "%PYTHON%" "%ROOT_DIR%\satgpt_config.py" backend
start "SatGPT Frontend Production" /min cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm run start:prod

echo Production services started. Open the frontend port configured in .env.
exit /b 0
