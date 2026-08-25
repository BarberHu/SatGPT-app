@echo off
setlocal EnableExtensions

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"

echo ==========================================
echo       SatGPT Production Build
echo ==========================================
echo Root: %ROOT_DIR%
echo.

if not exist "%ROOT_DIR%\frontend\node_modules\react-scripts\bin\react-scripts.js" goto :MissingDependencies
if not exist "%ROOT_DIR%\runtime\node_modules\.bin\tsc.cmd" goto :MissingDependencies
if not exist "%ROOT_DIR%\.env" (
    echo [ERROR] Missing %ROOT_DIR%\.env
    exit /b 1
)

echo [1/3] Syncing public frontend environment...
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%helpers\sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 exit /b 1

echo.
echo [2/3] Building optimized React assets...
pushd "%ROOT_DIR%\frontend"
call npm run build
if errorlevel 1 (
    popd
    exit /b 1
)
popd

echo.
echo [3/3] Compiling CopilotKit runtime...
pushd "%ROOT_DIR%\runtime"
call npm run build
if errorlevel 1 (
    popd
    exit /b 1
)
popd

if not exist "%ROOT_DIR%\frontend\build\index.html" (
    echo [ERROR] React production build was not created.
    exit /b 1
)
if not exist "%ROOT_DIR%\runtime\dist\server.js" (
    echo [ERROR] Runtime production build was not created.
    exit /b 1
)

echo.
echo Production build completed successfully.
exit /b 0

:MissingDependencies
echo [ERROR] Dependencies are missing. Run scripts\windows\setup_windows.bat first.
exit /b 1
