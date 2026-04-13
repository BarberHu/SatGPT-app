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

if not "%SATGPT_HTTP_PROXY%"=="" (
    set "HTTP_PROXY=%SATGPT_HTTP_PROXY%"
    set "HTTPS_PROXY=%SATGPT_HTTP_PROXY%"
    echo Using proxy: %SATGPT_HTTP_PROXY%
    echo.
)

echo [1/4] Checking port usage...
for %%P in (5001 8000 5000 3000) do (
    netstat -ano | findstr :%%P >nul 2>&1
    if not errorlevel 1 echo Warning: Port %%P is already in use.
)

echo.
echo [2/4] Starting Flask backend on 5001...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: start "Flask Backend" cmd /k cd /d "%ROOT_DIR%" ^&^& "%PYTHON_EXE%" app.py
) else (
    start "Flask Backend" cmd /k cd /d "%ROOT_DIR%" ^&^& "%PYTHON_EXE%" app.py
)

echo [3/4] Starting FastAPI agent on 8000...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: start "FastAPI Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" -m uvicorn server:app --host 0.0.0.0 --port 8000
) else (
    start "FastAPI Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" -m uvicorn server:app --host 0.0.0.0 --port 8000
)

echo [4/4] Starting Node services...
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
echo Flask Backend:      http://localhost:5001
echo FastAPI Agent:      http://localhost:8000
echo CopilotKit Runtime: http://localhost:5000
echo React Frontend:     http://localhost:3000
echo ==========================================
exit /b 0
