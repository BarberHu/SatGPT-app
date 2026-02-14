@echo off
REM SatGPT Unified Stop Script
REM Stops all services by killing processes on their ports

echo ==========================================
echo     SatGPT + FloodAgent Stop Script
echo ==========================================
echo.

echo [1/4] Stopping Flask Backend (Port 5001)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5001 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [2/4] Stopping FastAPI Agent (Port 8000)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [3/4] Stopping CopilotKit Runtime (Port 5000)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo [4/4] Stopping React Frontend (Port 3000)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo ==========================================
echo All services stopped!
echo ==========================================
echo.
echo Press any key to close this window...
pause >nul
