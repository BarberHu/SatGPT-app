@echo off
setlocal

set "SCRIPT_DIR=%~dp0"

if /I "%~1"=="setup" goto :setup
if /I "%~1"=="dev" goto :dev
if /I "%~1"=="build" goto :build
if /I "%~1"=="prod" goto :prod
if /I "%~1"=="deploy" goto :deploy
if /I "%~1"=="help" goto :help
if "%~1"=="" goto :help

echo Unknown command: %~1
goto :error

:setup
call "%SCRIPT_DIR%setup_windows.bat"
exit /b %ERRORLEVEL%

:dev
call "%SCRIPT_DIR%start_windows.bat" "%~2"
exit /b %ERRORLEVEL%

:build
call "%SCRIPT_DIR%build_production.bat"
exit /b %ERRORLEVEL%

:prod
call "%SCRIPT_DIR%start_production.bat"
exit /b %ERRORLEVEL%

:deploy
call "%SCRIPT_DIR%build_production.bat"
if errorlevel 1 exit /b %ERRORLEVEL%
call "%SCRIPT_DIR%start_production.bat"
exit /b %ERRORLEVEL%

:help
echo Usage: scripts\windows\satgpt.bat COMMAND [OPTIONS]
echo.
echo   setup                Install dependencies and create .env
echo   dev                  Start the development frontend on port 3001 and backend on port 8001
echo   dev --frontend-only  Start the frontend on port 3001 with the existing development backend on port 8001
echo   build                Build production assets
echo   prod                 Start an existing production build on port 3000
echo   deploy               Build and start production on port 3000
exit /b 0

:error
exit /b 2
