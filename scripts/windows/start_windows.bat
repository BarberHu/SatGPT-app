@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
set "HELPERS_DIR=%SCRIPT_DIR%helpers\"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"

set "VENV_DIR=%ROOT_DIR%\flood-venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
set "REQUIRED_NODE_VERSION=v22.16.0"
set "NODE_VERSION_FILE=%TEMP%\satgpt-node-version.txt"

echo ==========================================
echo        SatGPT Windows Start Script
echo ==========================================
echo Root: %ROOT_DIR%
echo.

echo [1/5] Checking installed environment...
if not exist "%PYTHON_EXE%" (
    set "ERROR_MESSAGE=Python virtual environment is missing: %PYTHON_EXE%"
    set "FIX_MESSAGE=Run scripts\windows\setup_windows.bat first."
    goto :Fail
)

if not exist "%ROOT_DIR%\.env" (
    set "ERROR_MESSAGE=.env is missing."
    set "FIX_MESSAGE=Run scripts\windows\setup_windows.bat, then fill in .env."
    goto :Fail
)

where node >nul 2>&1
if errorlevel 1 (
    set "ERROR_MESSAGE=node was not found in PATH."
    set "FIX_MESSAGE=Install Node.js %REQUIRED_NODE_VERSION% or adjust PATH."
    goto :Fail
)

node --version > "%NODE_VERSION_FILE%" 2>&1
if errorlevel 1 (
    type "%NODE_VERSION_FILE%"
    set "ERROR_MESSAGE=node --version failed."
    set "FIX_MESSAGE=Fix PATH so Node.js %REQUIRED_NODE_VERSION% is used first."
    goto :Fail
)

set /p "NODE_VERSION_OUTPUT="<"%NODE_VERSION_FILE%"
if /I not "%NODE_VERSION_OUTPUT%"=="%REQUIRED_NODE_VERSION%" (
    set "ERROR_MESSAGE=Expected Node.js %REQUIRED_NODE_VERSION%, but found: %NODE_VERSION_OUTPUT%"
    set "FIX_MESSAGE=Install Node.js %REQUIRED_NODE_VERSION% or adjust PATH order."
    goto :Fail
)

where npm >nul 2>&1
if errorlevel 1 (
    set "ERROR_MESSAGE=npm was not found in PATH."
    set "FIX_MESSAGE=Install Node.js %REQUIRED_NODE_VERSION% with npm, or add npm to PATH."
    goto :Fail
)

if not exist "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js" (
    set "ERROR_MESSAGE=Frontend dependencies are missing or incomplete."
    set "FIX_MESSAGE=Run scripts\windows\setup_windows.bat first."
    goto :Fail
)

if not exist "%ROOT_DIR%\runtime\node_modules\.bin\tsx.cmd" (
    set "ERROR_MESSAGE=Runtime dependencies are missing or incomplete."
    set "FIX_MESSAGE=Run scripts\windows\setup_windows.bat first."
    goto :Fail
)
echo OK: Required local environment is present

echo.
echo [2/5] Loading .env launch settings...
for /f "usebackq delims=" %%A in (`powershell -ExecutionPolicy Bypass -File "%HELPERS_DIR%load_launch_env.ps1" -RootDir "%ROOT_DIR%"`) do set "%%A"
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to load .env launch settings."
    set "FIX_MESSAGE=Check .env formatting."
    goto :Fail
)

if not "%SATGPT_HTTP_PROXY%"=="" (
    set "HTTP_PROXY=%SATGPT_HTTP_PROXY%"
    set "HTTPS_PROXY=%SATGPT_HTTP_PROXY%"
    set "NO_PROXY=localhost,127.0.0.1,::1"
    set "no_proxy=localhost,127.0.0.1,::1"
    echo Proxy: %SATGPT_HTTP_PROXY%
)
echo Agent port: %AGENT_PORT%
echo Runtime port: %RUNTIME_PORT%
echo Frontend port: %FRONTEND_PORT%

echo.
echo [3/5] Syncing frontend public environment...
powershell -ExecutionPolicy Bypass -File "%HELPERS_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to sync frontend environment."
    set "FIX_MESSAGE=Check .env formatting."
    goto :Fail
)

echo.
echo [4/5] Checking port availability...
powershell -NoProfile -ExecutionPolicy Bypass -File "%HELPERS_DIR%check_ports_available.ps1" -Ports "%AGENT_PORT%,%RUNTIME_PORT%,%FRONTEND_PORT%"
if errorlevel 1 (
    set "ERROR_MESSAGE=One or more configured ports are already in use."
    set "FIX_MESSAGE=Stop the listed process, or change AGENT_PORT / RUNTIME_PORT / FRONTEND_PORT in .env."
    goto :Fail
)

echo.
echo [5/5] Starting services...
start "FastAPI Agent" cmd /k cd /d "%ROOT_DIR%\agent" ^&^& "%PYTHON_EXE%" server.py
start "CopilotKit Runtime" cmd /k cd /d "%ROOT_DIR%\runtime" ^&^& call npm start
start "React Frontend" cmd /k cd /d "%ROOT_DIR%\frontend" ^&^& call npm start

echo.
echo ==========================================
echo Startup commands dispatched.
echo FastAPI Agent:      http://%SATGPT_PUBLIC_HOST%:%AGENT_PORT%
echo CopilotKit Runtime: http://%SATGPT_PUBLIC_HOST%:%RUNTIME_PORT%
echo React Frontend:     http://%SATGPT_PUBLIC_HOST%:%FRONTEND_PORT%
echo ==========================================
set "EXIT_CODE=0"
goto :PauseAndExit

:Fail
echo.
echo [ERROR] %ERROR_MESSAGE%
if not "%FIX_MESSAGE%"=="" echo Fix: %FIX_MESSAGE%
set "EXIT_CODE=1"
goto :PauseAndExit

:PauseAndExit
del "%NODE_VERSION_FILE%" >nul 2>&1
echo.
if not "%SATGPT_SKIP_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
