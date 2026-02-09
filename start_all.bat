@echo off
REM SatGPT Unified Startup Script
REM Starts Flask backend, FastAPI Agent, CopilotKit Runtime, and React frontend

echo ==========================================
echo     SatGPT + FloodAgent Startup Script
echo ==========================================
echo.

REM Check ports
echo [1/4] Checking port usage...
netstat -ano | findstr :5001 >nul 2>&1
if %errorlevel%==0 (
    echo Warning: Port 5001 is in use (Flask)
)
netstat -ano | findstr :8000 >nul 2>&1
if %errorlevel%==0 (
    echo Warning: Port 8000 is in use (FastAPI Agent)
)
netstat -ano | findstr :5000 >nul 2>&1
if %errorlevel%==0 (
    echo Warning: Port 5000 is in use (CopilotKit Runtime)
)
netstat -ano | findstr :3000 >nul 2>&1
if %errorlevel%==0 (
    echo Warning: Port 3000 is in use (React Frontend)
)

echo.
echo [1/4] Starting Flask Backend (Port 5001)...
start "Flask Backend" cmd /k "cd /d %~dp0 && call flood-venv\Scripts\activate.bat && python app.py"

echo [2/4] Starting FastAPI Agent (Port 8000)...
start "FastAPI Agent" cmd /k "cd /d %~dp0agent && call venv\Scripts\activate.bat && python -m uvicorn server:app --port 8000"

timeout /t 3 /nobreak >nul

echo [3/4] Starting CopilotKit Runtime (Port 5000)...
start "CopilotKit Runtime" cmd /k "cd /d %~dp0runtime && npm start"

timeout /t 3 /nobreak >nul

echo [4/4] Starting React Frontend (Port 3000)...
start "React Frontend" cmd /k "cd /d %~dp0frontend && npm start"

echo.
echo ==========================================
echo All services started!
echo ------------------------------------------
echo Flask Backend:      http://localhost:5001
echo FastAPI Agent:      http://localhost:8000
echo CopilotKit Runtime: http://localhost:5000
echo React Frontend:     http://localhost:3000
echo ==========================================
echo.
echo Press any key to close this window...
pause >nul
