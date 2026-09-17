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
call "%SCRIPT_DIR%start_windows.bat"
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
echo Usage: scripts\windows\satgpt.bat COMMAND
echo.
echo   setup   Install dependencies and create .env
echo   dev     Start the development services
echo   build   Build production assets
echo   prod    Start an existing production build
echo   deploy  Build and start production
exit /b 0

:error
exit /b 2
