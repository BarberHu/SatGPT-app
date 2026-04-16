@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "VENV_DIR=%ROOT_DIR%\flood-venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
set "DRY_RUN=0"

if /I "%~1"=="--dry-run" set "DRY_RUN=1"

echo ==========================================
echo        SatGPT Windows Start Script
echo ==========================================
echo Root: %ROOT_DIR%
echo.

if not exist "%PYTHON_EXE%" (
    echo [ERROR] Missing Python environment: "%PYTHON_EXE%"
    echo Run "scripts\windows\setup_windows.bat" first.
    exit /b 1
)

if not exist "%ROOT_DIR%\.env" (
    echo [ERROR] Missing .env file.
    echo Run "scripts\windows\setup_windows.bat" and then fill in .env.
    exit /b 1
)

if not exist "%ROOT_DIR%\frontend\node_modules" (
    echo [ERROR] Missing frontend\node_modules.
    echo Run "scripts\windows\setup_windows.bat" first.
    exit /b 1
)

if not exist "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js" (
    echo [ERROR] Frontend dependencies are incomplete: react-scripts is missing.
    echo Run "scripts\windows\setup_windows.bat" or reinstall frontend dependencies.
    exit /b 1
)

if not exist "%ROOT_DIR%\runtime\node_modules" (
    echo [ERROR] Missing runtime\node_modules.
    echo Run "scripts\windows\setup_windows.bat" first.
    exit /b 1
)

if not exist "%ROOT_DIR%\runtime\node_modules\.bin\tsx.cmd" (
    echo [ERROR] Runtime dependencies are incomplete: tsx is missing.
    echo Run "scripts\windows\setup_windows.bat" or reinstall runtime dependencies.
    exit /b 1
)

for /f "usebackq delims=" %%A in (`powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%load_launch_env.ps1" -RootDir "%ROOT_DIR%"`) do set "%%A"

if not "%SATGPT_HTTP_PROXY%"=="" (
    set "HTTP_PROXY=%SATGPT_HTTP_PROXY%"
    set "HTTPS_PROXY=%SATGPT_HTTP_PROXY%"
    echo Using proxy: %SATGPT_HTTP_PROXY%
    echo.
)

echo Syncing frontend public environment from root .env...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
) else (
    powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
    if errorlevel 1 exit /b 1
)

echo [1/3] Checking port usage...
for %%P in (%AGENT_PORT% %RUNTIME_PORT% %FRONTEND_PORT%) do (
    powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort %%P -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
    if not errorlevel 1 echo Warning: Port %%P is already in use.
)

echo.
echo [2/3] Starting FastAPI agent on %AGENT_PORT%...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: start "FastAPI Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" server.py
) else (
    start "FastAPI Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" server.py
)

echo [3/3] Starting Node services...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: start "CopilotKit Runtime" cmd /k cd /d "%ROOT_DIR%\runtime" ^&^& call npm start
    echo DRY-RUN: start "React Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm start
) else (
    start "CopilotKit Runtime" cmd /k cd /d "%ROOT_DIR%\runtime" ^&^& call npm start
    start "React Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm start
)

echo.
echo ==========================================
echo Startup commands dispatched.
echo FastAPI Agent:      http://%SATGPT_PUBLIC_HOST%:%AGENT_PORT%
echo CopilotKit Runtime: http://%SATGPT_PUBLIC_HOST%:%RUNTIME_PORT%
echo React Frontend:     http://%SATGPT_PUBLIC_HOST%:%FRONTEND_PORT%
echo ==========================================
exit /b 0
