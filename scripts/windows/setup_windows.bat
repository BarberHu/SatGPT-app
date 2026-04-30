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
    set "EXIT_CODE=1"
    goto :PauseAndExit
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found in PATH.
    set "EXIT_CODE=1"
    goto :PauseAndExit
)

if not exist "%VENV_DIR%\Scripts\python.exe" (
    echo [1/5] Creating Python virtual environment...
    if "%DRY_RUN%"=="1" (
        echo DRY-RUN: python -m venv "%VENV_DIR%"
    ) else (
        python -m venv "%VENV_DIR%"
        if errorlevel 1 (
            set "EXIT_CODE=1"
            goto :PauseAndExit
        )
    )
) else (
    echo [1/5] Reusing existing virtual environment: "%VENV_DIR%"
)

echo [2/5] Upgrading pip...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install --upgrade pip
) else (
    "%PYTHON_EXE%" -m pip install --upgrade pip
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
)

echo [3/6] Pinning setuptools compatibility...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install "setuptools<81"
) else (
    "%PYTHON_EXE%" -m pip install "setuptools<81"
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
)

echo [4/6] Installing Python dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\requirements.txt"
    echo DRY-RUN: "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
) else (
    "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\requirements.txt"
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
    "%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
)

echo [5/6] Installing frontend dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: cd /d "%ROOT_DIR%\frontend" ^&^& call npm install
) else (
    pushd "%ROOT_DIR%\frontend"
    call npm install
    if errorlevel 1 (
        popd
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
    popd
)

echo [6/6] Installing runtime dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: cd /d "%ROOT_DIR%\runtime" ^&^& call npm install
) else (
    pushd "%ROOT_DIR%\runtime"
    call npm install
    if errorlevel 1 (
        popd
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
    popd
)

echo.
echo Validating installed dependencies...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: check "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js"
    echo DRY-RUN: check "%ROOT_DIR%\runtime\node_modules\.bin\tsx.cmd"
) else (
    if not exist "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js" (
        echo [ERROR] Frontend dependency check failed: react-scripts is missing.
        echo Try running: cd /d "%ROOT_DIR%\frontend" ^&^& npm install
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
    if not exist "%ROOT_DIR%\runtime\node_modules\.bin\tsx.cmd" (
        echo [ERROR] Runtime dependency check failed: tsx is missing.
        echo Try running: cd /d "%ROOT_DIR%\runtime" ^&^& npm install
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
)

if not exist "%ROOT_DIR%\.env" (
    echo.
    echo Creating .env from .env.example...
    if "%DRY_RUN%"=="1" (
        echo DRY-RUN: copy "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env"
    ) else (
        copy /Y "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
        if errorlevel 1 (
            set "EXIT_CODE=1"
            goto :PauseAndExit
        )
    )
) else (
    echo.
    echo Existing .env detected. Keeping current file.
)

echo.
echo Syncing frontend public environment from root .env...
if "%DRY_RUN%"=="1" (
    echo DRY-RUN: powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
) else (
    powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
    if errorlevel 1 (
        set "EXIT_CODE=1"
        goto :PauseAndExit
    )
)

echo.
echo ==========================================
echo Setup completed.
echo Next:
echo 1. Fill in "%ROOT_DIR%\.env" with your API keys and service account path.
echo 2. frontend\.env.local will be generated from the root .env.
echo 3. Run "scripts\windows\start_windows.bat" to start all services.
echo ==========================================
set "EXIT_CODE=0"
goto :PauseAndExit

:PauseAndExit
echo.
if not "%SATGPT_SKIP_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
