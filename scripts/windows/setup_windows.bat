@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\flood-venv\Scripts\python.exe"

where py >nul 2>&1 || (echo Python 3.12 is required. & exit /b 1)
where node >nul 2>&1 || (echo Node.js is required. & exit /b 1)
where npm >nul 2>&1 || (echo npm is required. & exit /b 1)

py -3.12 --version || exit /b 1
node --version || exit /b 1
npm --version || exit /b 1

if not exist "%PYTHON%" py -3.12 -m venv "%ROOT_DIR%\flood-venv"
if errorlevel 1 exit /b 1

"%PYTHON%" -m pip install --upgrade pip "setuptools<81"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip install -r "%ROOT_DIR%\agent\requirements.txt"
if errorlevel 1 exit /b 1

pushd "%ROOT_DIR%\frontend"
call npm install
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" exit /b %INSTALL_EXIT%

pushd "%ROOT_DIR%\runtime"
call npm install
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" exit /b %INSTALL_EXIT%

if not exist "%ROOT_DIR%\.env" copy "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%helpers\sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 exit /b 1

echo Setup completed. Edit %ROOT_DIR%\.env before starting the application.
exit /b 0
