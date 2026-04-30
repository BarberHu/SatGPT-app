@echo off
setlocal EnableExtensions

set "SATGPT_SKIP_PAUSE=1"
call "%~dp0scripts\windows\start_windows.bat" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
pause
exit /b %EXIT_CODE%
