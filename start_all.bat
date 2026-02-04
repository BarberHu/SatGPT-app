@echo off
REM SatGPT 统一启动脚本
REM 同时启动 Flask 后端、FastAPI Agent、CopilotKit Runtime、React 前端

echo ==========================================
echo     SatGPT + FloodAgent 统一启动脚本
echo ==========================================
echo.

REM 检查端口
echo [1/4] 检查端口占用...
netstat -ano | findstr :5001 >nul 2>&1
if %errorlevel%==0 (
    echo 警告: 端口 5001 已被占用 (Flask)
)
netstat -ano | findstr :8000 >nul 2>&1
if %errorlevel%==0 (
    echo 警告: 端口 8000 已被占用 (FastAPI Agent)
)
netstat -ano | findstr :5000 >nul 2>&1
if %errorlevel%==0 (
    echo 警告: 端口 5000 已被占用 (CopilotKit Runtime)
)
netstat -ano | findstr :3000 >nul 2>&1
if %errorlevel%==0 (
    echo 警告: 端口 3000 已被占用 (React Frontend)
)

echo.
echo [2/4] 启动 Flask 后端 (端口 5001)...
start "Flask Backend" cmd /k "cd /d %~dp0 && set FLASK_APP=app.py && set FLASK_RUN_PORT=5001 && python app.py"

echo [3/4] 启动 FastAPI Agent (端口 8000)...
start "FastAPI Agent" cmd /k "cd /d %~dp0agent && python server.py"

timeout /t 3 /nobreak >nul

echo [4/4] 启动 CopilotKit Runtime (端口 5000)...
start "CopilotKit Runtime" cmd /k "cd /d %~dp0runtime && npm run dev"

timeout /t 3 /nobreak >nul

echo [5/5] 启动 React 前端 (端口 3000)...
start "React Frontend" cmd /k "cd /d %~dp0frontend && npm start"

echo.
echo ==========================================
echo 所有服务已启动！
echo ------------------------------------------
echo Flask 后端:        http://localhost:5001
echo FastAPI Agent:     http://localhost:8000
echo CopilotKit Runtime: http://localhost:5000
echo React 前端:         http://localhost:3000
echo ==========================================
echo.
echo 按任意键关闭此窗口...
pause >nul
