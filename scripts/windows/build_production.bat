@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT_DIR=%%~fI"

if not exist "%ROOT_DIR%\.env" (echo Missing %ROOT_DIR%\.env & exit /b 1)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%helpers\sync_frontend_env.ps1" -RootDir "%ROOT_DIR%"
if errorlevel 1 exit /b 1

pushd "%ROOT_DIR%\frontend"
call npm run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" exit /b %BUILD_EXIT%

pushd "%ROOT_DIR%\runtime"
call npm run build
set "BUILD_EXIT=%ERRORLEVEL%"
popd
if not "%BUILD_EXIT%"=="0" exit /b %BUILD_EXIT%

echo Production build completed.
exit /b 0
