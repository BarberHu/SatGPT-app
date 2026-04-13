@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
call "%SCRIPT_DIR%scripts\windows\start_windows.bat" %*
exit /b %errorlevel%
