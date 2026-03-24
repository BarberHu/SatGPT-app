@echo off
setlocal EnableExtensions

REM SatGPT Worktree Startup Script
REM Uses the current worktree's code, but can fall back to the main worktree's Python venvs.

set "REPO_ROOT=%~dp0"
set "ENV_ROOT=%REPO_ROOT%"
set "MAIN_WORKTREE="

if defined SATGPT_ENV_ROOT (
    set "ENV_ROOT=%SATGPT_ENV_ROOT%"
)

if not exist "%ENV_ROOT%flood-venv\Scripts\activate.bat" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$repo='%REPO_ROOT:\=\\%'; $blocks=((git -C $repo worktree list --porcelain) -join \"`n\") -split \"`n`n\"; foreach($block in $blocks){ if($block -match 'branch refs/heads/main'){ ($block -split \"`n\" | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_.Substring(9) }); break } }"`) do (
        set "MAIN_WORKTREE=%%i"
    )
    if defined MAIN_WORKTREE (
        set "ENV_ROOT=%MAIN_WORKTREE%\"
    )
)

if not exist "%ENV_ROOT%flood-venv\Scripts\activate.bat" (
    echo [ERROR] Flask venv not found.
    echo Current code root: %REPO_ROOT%
    echo Checked env root: %ENV_ROOT%
    echo You can set SATGPT_ENV_ROOT to your main repo path and retry.
    pause
    exit /b 1
)

if not exist "%ENV_ROOT%agent\venv\Scripts\activate.bat" (
    echo [ERROR] Agent venv not found.
    echo Current code root: %REPO_ROOT%
    echo Checked env root: %ENV_ROOT%
    echo You can set SATGPT_ENV_ROOT to your main repo path and retry.
    pause
    exit /b 1
)

echo ==========================================
echo   SatGPT Worktree Startup Script
echo ==========================================
echo Code root: %REPO_ROOT%
echo Env root:  %ENV_ROOT%
echo.

REM Set proxy for Google Earth Engine connection
set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890

echo [1/4] Checking port usage...
netstat -ano | findstr :5001 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 5001 is in use ^(Flask^)
netstat -ano | findstr :8000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 8000 is in use ^(FastAPI Agent^)
netstat -ano | findstr :5000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 5000 is in use ^(CopilotKit Runtime^)
netstat -ano | findstr :3000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 3000 is in use ^(React Frontend^)

echo.
echo [2/4] Starting Flask Backend ^(Port 5001^)...
start "Flask Backend [%REPO_ROOT%]" cmd /k "cd /d %REPO_ROOT% && call "%ENV_ROOT%flood-venv\Scripts\activate.bat" && python app.py"

echo [3/4] Starting FastAPI Agent ^(Port 8000^)...
start "FastAPI Agent [%REPO_ROOT%]" cmd /k "cd /d %REPO_ROOT%agent && call "%ENV_ROOT%agent\venv\Scripts\activate.bat" && python -m uvicorn server:app --host 0.0.0.0 --port 8000"

timeout /t 3 /nobreak >nul

echo [4/4] Starting CopilotKit Runtime ^(Port 5000^)...
start "CopilotKit Runtime [%REPO_ROOT%]" cmd /k "cd /d %REPO_ROOT%runtime && npm start"

timeout /t 3 /nobreak >nul

echo [5/5] Starting React Frontend ^(Port 3000^)...
start "React Frontend [%REPO_ROOT%]" cmd /k "cd /d %REPO_ROOT%frontend && npm start"

echo.
echo ==========================================
echo All services started for this worktree.
echo ------------------------------------------
echo Flask Backend:      http://localhost:5001
echo FastAPI Agent:      http://localhost:8000
echo CopilotKit Runtime: http://localhost:5000
echo React Frontend:     http://localhost:3000
echo ==========================================
echo.
echo Press any key to close this window...
pause >nul
