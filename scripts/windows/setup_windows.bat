@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "HELPERS_DIR=%SCRIPT_DIR%helpers\"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"

set "VENV_DIR=%ROOT_DIR%\flood-venv"
set "PYTHON_EXE=%VENV_DIR%\Scripts\python.exe"
set "PYTHON_CMD=py -3.12"
set "REQUIRED_PYTHON_VERSION=3.12.10"
set "REQUIRED_NODE_VERSION=v22.16.0"
set "PYTHON_VERSION_FILE=%TEMP%\satgpt-python-version.txt"
set "NODE_VERSION_FILE=%TEMP%\satgpt-node-version.txt"

echo ==========================================
echo        SatGPT Windows Setup Script
echo ==========================================
echo Root: %ROOT_DIR%
echo Required Python: %REQUIRED_PYTHON_VERSION%
echo Required Node.js: %REQUIRED_NODE_VERSION%
echo.

echo [1/7] Checking Python...
where py >nul 2>&1
if errorlevel 1 (
    set "ERROR_MESSAGE=Python launcher py was not found."
    set "FIX_MESSAGE=Install Python %REQUIRED_PYTHON_VERSION% and enable the Python launcher."
    goto :Fail
)

%PYTHON_CMD% --version > "%PYTHON_VERSION_FILE%" 2>&1
if errorlevel 1 (
    type "%PYTHON_VERSION_FILE%"
    set "ERROR_MESSAGE=Python 3.12 is not available through py -3.12."
    set "FIX_MESSAGE=Install Python %REQUIRED_PYTHON_VERSION%, then rerun this script."
    goto :Fail
)

set /p "PYTHON_VERSION_OUTPUT="<"%PYTHON_VERSION_FILE%"
if /I not "%PYTHON_VERSION_OUTPUT%"=="Python %REQUIRED_PYTHON_VERSION%" (
    set "ERROR_MESSAGE=Expected Python %REQUIRED_PYTHON_VERSION%, but found: %PYTHON_VERSION_OUTPUT%"
    set "FIX_MESSAGE=Make sure py -3.12 points to Python %REQUIRED_PYTHON_VERSION%."
    goto :Fail
)
echo OK: %PYTHON_VERSION_OUTPUT%

echo.
echo [2/7] Checking Node.js and npm...
where node >nul 2>&1
if errorlevel 1 (
    set "ERROR_MESSAGE=node was not found in PATH."
    set "FIX_MESSAGE=Install Node.js %REQUIRED_NODE_VERSION% or put it before other node.exe entries in PATH."
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
echo OK: Node.js %NODE_VERSION_OUTPUT%

where npm >nul 2>&1
if errorlevel 1 (
    set "ERROR_MESSAGE=npm was not found in PATH."
    set "FIX_MESSAGE=Install Node.js %REQUIRED_NODE_VERSION% with npm, or add npm to PATH."
    goto :Fail
)
echo OK: npm is available

echo.
echo [3/7] Preparing Python virtual environment...
if exist "%PYTHON_EXE%" (
    "%PYTHON_EXE%" --version > "%PYTHON_VERSION_FILE%" 2>&1
    if errorlevel 1 (
        set "ERROR_MESSAGE=Existing virtual environment is broken."
        set "FIX_MESSAGE=Delete %VENV_DIR% and rerun this script."
        goto :Fail
    )

    set /p "VENV_PYTHON_VERSION="<"%PYTHON_VERSION_FILE%"
    if /I not "!VENV_PYTHON_VERSION!"=="Python %REQUIRED_PYTHON_VERSION%" (
        echo Existing virtual environment uses !VENV_PYTHON_VERSION!.
        echo Recreating %VENV_DIR% with Python %REQUIRED_PYTHON_VERSION%...
        rmdir /s /q "%VENV_DIR%"
        if exist "%VENV_DIR%" (
            set "ERROR_MESSAGE=Could not remove the old virtual environment."
            set "FIX_MESSAGE=Close any Python process using %VENV_DIR%, then rerun this script."
            goto :Fail
        )
    ) else (
        echo OK: Reusing %VENV_DIR%
    )
)

if not exist "%PYTHON_EXE%" (
    echo Creating %VENV_DIR%...
    %PYTHON_CMD% -m venv "%VENV_DIR%"
    if errorlevel 1 (
        set "ERROR_MESSAGE=Failed to create the Python virtual environment."
        set "FIX_MESSAGE=Check Python %REQUIRED_PYTHON_VERSION% installation and rerun this script."
        goto :Fail
    )
)
echo OK: Virtual environment is ready

echo.
echo [4/7] Installing Python packaging tools...
"%PYTHON_EXE%" -m pip install --upgrade pip
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to upgrade pip."
    set "FIX_MESSAGE=Check network access or pip configuration."
    goto :Fail
)

"%PYTHON_EXE%" -m pip install "setuptools<81"
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to install setuptools compatibility pin."
    set "FIX_MESSAGE=Check network access or pip configuration."
    goto :Fail
)
echo OK: Python packaging tools are ready

echo.
echo [5/7] Installing FastAPI backend Python dependencies...
"%PYTHON_EXE%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to install FastAPI backend Python dependencies."
    set "FIX_MESSAGE=Review the pip error above, then rerun this script."
    goto :Fail
)
echo OK: Python dependencies are installed

echo.
echo [6/7] Installing Node.js dependencies...
pushd "%ROOT_DIR%\frontend"
if errorlevel 1 (
    set "ERROR_MESSAGE=Could not enter frontend directory."
    set "FIX_MESSAGE=Check the repository checkout."
    goto :Fail
)
call npm install
if errorlevel 1 (
    popd
    set "ERROR_MESSAGE=Failed to install frontend dependencies."
    set "FIX_MESSAGE=Review the npm error above, then rerun this script."
    goto :Fail
)
popd

pushd "%ROOT_DIR%\runtime"
if errorlevel 1 (
    set "ERROR_MESSAGE=Could not enter runtime directory."
    set "FIX_MESSAGE=Check the repository checkout."
    goto :Fail
)
call npm install
if errorlevel 1 (
    popd
    set "ERROR_MESSAGE=Failed to install runtime dependencies."
    set "FIX_MESSAGE=Review the npm error above, then rerun this script."
    goto :Fail
)
popd
echo OK: Node.js dependencies are installed

echo.
echo [7/7] Validating environment files and key dependencies...
if not exist "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js" (
    set "ERROR_MESSAGE=Frontend validation failed: react-scripts is missing."
    set "FIX_MESSAGE=Run npm install in %ROOT_DIR%\frontend, or rerun this script."
    goto :Fail
)

if not exist "%ROOT_DIR%\runtime\node_modules\.bin\tsx.cmd" (
    set "ERROR_MESSAGE=Runtime validation failed: tsx is missing."
    set "FIX_MESSAGE=Run npm install in %ROOT_DIR%\runtime, or rerun this script."
    goto :Fail
)

if not exist "%ROOT_DIR%\.env" (
    echo Creating .env from .env.example...
    copy /Y "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
    if errorlevel 1 (
        set "ERROR_MESSAGE=Failed to create .env."
        set "FIX_MESSAGE=Check file permissions in the repository root."
        goto :Fail
    )
) else (
    echo OK: Existing .env detected. Keeping current file.
)

echo Syncing frontend public environment...
powershell -ExecutionPolicy Bypass -File "%HELPERS_DIR%sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 (
    set "ERROR_MESSAGE=Failed to sync frontend environment."
    set "FIX_MESSAGE=Check .env formatting, then rerun this script."
    goto :Fail
)
echo OK: Environment files are ready

echo.
echo ==========================================
echo Setup completed.
echo Next:
echo 1. Fill in "%ROOT_DIR%\.env" with API keys and credential paths.
echo 2. Run "start_all.bat" from the repository root.
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
del "%PYTHON_VERSION_FILE%" >nul 2>&1
del "%NODE_VERSION_FILE%" >nul 2>&1
echo.
if not "%SATGPT_SKIP_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
