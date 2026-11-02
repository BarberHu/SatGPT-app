@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\harness\.venv\Scripts\python.exe"
set "BASIC_PYTHON=%ROOT_DIR%\basic-venv\Scripts\python.exe"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)
if not exist "%PYTHON%" (echo Missing Python environment. Run setup first. & exit /b 1)
if not exist "%BASIC_PYTHON%" (echo Missing Basic API environment. Run setup first. & exit /b 1)

"%PYTHON%" "%ROOT_DIR%\satgpt_config.py" check || exit /b 1
start "SatGPT Basic API" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%BASIC_PYTHON%" "%ROOT_DIR%\satgpt_config.py" basic
start "SatGPT Harness" cmd /k cd /d "%ROOT_DIR%\harness" ^&^& "%PYTHON%" "%ROOT_DIR%\satgpt_config.py" harness
start "SatGPT Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm run dev

echo Development services started. Ports are configured in .env.
exit /b 0
