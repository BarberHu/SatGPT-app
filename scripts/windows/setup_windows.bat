@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"
set "PYTHON=%ROOT_DIR%\harness\.venv\Scripts\python.exe"

where python >nul 2>&1 || (echo Python 3.12 is required. & exit /b 1)
where node >nul 2>&1 || (echo Node.js is required. & exit /b 1)
where npm >nul 2>&1 || (echo npm is required. & exit /b 1)

python -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)" || (echo Python 3.12 is required. & exit /b 1)
node --version || exit /b 1
node -e "const [m,n]=process.versions.node.split('.').map(Number); process.exit((m===20&&n>=19)||(m===22&&n>=12)||m>22?0:1)" || (echo Node.js 20.19 or 22.12 and above is required. & exit /b 1)
call npm --version || exit /b 1

if not exist "%PYTHON%" python -m venv "%ROOT_DIR%\harness\.venv"
if errorlevel 1 exit /b 1
"%PYTHON%" -c "import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)" || (echo Existing harness/.venv must use Python 3.12. Back it up before recreating it. & exit /b 1)

"%PYTHON%" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip install -r "%ROOT_DIR%\requirements.txt"
if errorlevel 1 exit /b 1
"%PYTHON%" -m pip check
if errorlevel 1 exit /b 1

pushd "%ROOT_DIR%\frontend"
call npm ci
set "INSTALL_EXIT=%ERRORLEVEL%"
popd
if not "%INSTALL_EXIT%"=="0" exit /b %INSTALL_EXIT%

if not exist "%ROOT_DIR%\.env" copy "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
echo Setup completed. Edit %ROOT_DIR%\.env before starting the application.
exit /b 0
