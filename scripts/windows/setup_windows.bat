@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "VENV_DIR=%ROOT_DIR%\flood-venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
set "DRY_RUN=0"

if /I "%~1"=="--dry-run" set "DRY_RUN=1"

echo ==========================================
echo        SatGPT Windows Setup Script
echo ==========================================
echo Root: %ROOT_DIR%
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found in PATH.
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found in PATH.
    exit /b 1
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [1/5] Creating Python virtual environment...
    if "%DRY_RUN%"=="1" (
        echo DRY-RUN: python -m venv "%VENV_DIR%"
    ) else (
        python -m venv "%VENV_DIR%"
        if errorlevel 1 exit /b 1
    )
) else (
    echo [1/5] Reusing existing virtual environment: "%VENV_DIR%"
)

echo [2/5] Upgrading pip...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install --upgrade pip
) else (
    "%PYTHON_EXE%" -m pip install --upgrade pip
    if errorlevel 1 exit /b 1
)

echo [3/5] Installing Python dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\requirements.txt"
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
) else (
    "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\requirements.txt"
    if errorlevel 1 exit /b 1
    "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
    if errorlevel 1 exit /b 1
)

echo [4/5] Installing frontend dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: cd /d "%ROOT_DIR%\frontend" ^&^& npm install
) else (
    pushd "%ROOT_DIR%\frontend"
    npm install
    if errorlevel 1 (
        popd
        exit /b 1
    )
    popd
)

echo [5/5] Installing runtime dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: cd /d "%ROOT_DIR%\runtime" ^&^& npm install
) else (
    pushd "%ROOT_DIR%\runtime"
    npm install
    if errorlevel 1 (
        popd
        exit /b 1
    )
    popd
)

if not exist "%ROOT_DIR%\.env" (
    echo.
    echo Creating .env from .env.example...
    if "%DRY_RUN%"=="1" (
        echo DRY-RUN: copy "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env"
    ) else (
        copy /Y "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
        if errorlevel 1 exit /b 1
    )
) else (
    echo.
    echo Existing .env detected. Keeping current file.
)

echo.
echo ==========================================
echo Setup completed.
echo Next:
echo 1. Fill in "%ROOT_DIR%\.env" with your API keys and service account path.
echo 2. Run "scripts\windows\start_windows.bat" to start all services.
echo ==========================================
exit /b 0
