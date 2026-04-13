@echo off
setlocal EnableExtensions

REM SatGPT agent_layer Startup Script
REM Starts the agent_layer worktree while reusing Python envs from the main repo.

set "REPO_ROOT=%~dp0"
set "TARGET_BRANCH=agent_layer"
set "CODE_ROOT="
set "ENV_ROOT=%REPO_ROOT%"
set "MAIN_WORKTREE="

if defined SATGPT_ENV_ROOT (
    set "ENV_ROOT=%SATGPT_ENV_ROOT%"
)

for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$repo='%REPO_ROOT:\=\\%'; $branch='refs/heads/%TARGET_BRANCH%'; $blocks=((git -C $repo worktree list --porcelain) -join \"`n\") -split \"`n`n\"; foreach($block in $blocks){ if($block -match ('branch ' + [regex]::Escape($branch))){ ($block -split \"`n\" | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_.Substring(9) }); break } }"`) do (
    set "CODE_ROOT=%%i"
)

if not defined CODE_ROOT (
    echo [ERROR] Could not find a worktree for branch %TARGET_BRANCH%.
    echo Repo root: %REPO_ROOT%
    echo Hint: create the worktree first, then retry.
    pause
    exit /b 1
)

set "CODE_ROOT=%CODE_ROOT:/=\%"
if not "%CODE_ROOT:~-1%"=="\" (
    set "CODE_ROOT=%CODE_ROOT%\"
)

if not exist "%ENV_ROOT%flood-venv\Scripts\activate.bat" (
    for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$repo='%REPO_ROOT:\=\\%'; $blocks=((git -C $repo worktree list --porcelain) -join \"`n\") -split \"`n`n\"; foreach($block in $blocks){ if($block -match 'branch refs/heads/main'){ ($block -split \"`n\" | Where-Object { $_ -like 'worktree *' } | ForEach-Object { $_.Substring(9) }); break } }"`) do (
        set "MAIN_WORKTREE=%%i"
    )
    if defined MAIN_WORKTREE (
        set "ENV_ROOT=%MAIN_WORKTREE%\"
    )
)

set "ENV_ROOT=%ENV_ROOT:/=\%"
if not "%ENV_ROOT:~-1%"=="\" (
    set "ENV_ROOT=%ENV_ROOT%\"
)

if not exist "%ENV_ROOT%flood-venv\Scripts\activate.bat" (
    echo [ERROR] Flask venv not found.
    echo Code root: %CODE_ROOT%
    echo Checked env root: %ENV_ROOT%
    echo You can set SATGPT_ENV_ROOT to your main repo path and retry.
    pause
    exit /b 1
)

if not exist "%ENV_ROOT%agent\venv\Scripts\activate.bat" (
    echo [ERROR] Agent venv not found.
    echo Code root: %CODE_ROOT%
    echo Checked env root: %ENV_ROOT%
    echo You can set SATGPT_ENV_ROOT to your main repo path and retry.
    pause
    exit /b 1
)

echo ==========================================
echo   SatGPT agent_layer Startup Script
echo ==========================================
echo Branch:    %TARGET_BRANCH%
echo Code root: %CODE_ROOT%
echo Env root:  %ENV_ROOT%
echo.

set HTTP_PROXY=http://127.0.0.1:7890
set HTTPS_PROXY=http://127.0.0.1:7890
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

echo [1/5] Checking port usage...
netstat -ano | findstr :5001 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 5001 is in use ^(Flask^)
netstat -ano | findstr :8000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 8000 is in use ^(FastAPI Agent^)
netstat -ano | findstr :5000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 5000 is in use ^(CopilotKit Runtime^)
netstat -ano | findstr :3000 >nul 2>&1
if %errorlevel%==0 echo Warning: Port 3000 is in use ^(React Frontend^)

echo.
echo [2/5] Starting Flask Backend ^(Port 5001^)...
start "Flask Backend [%TARGET_BRANCH%]" cmd /k cd /d "%CODE_ROOT%" ^&^& call "%ENV_ROOT%flood-venv\Scripts\activate.bat" ^&^& python app.py

echo [3/5] Starting FastAPI Agent ^(Port 8000^)...
start "FastAPI Agent [%TARGET_BRANCH%]" cmd /k cd /d "%CODE_ROOT%agent" ^&^& call "%ENV_ROOT%agent\venv\Scripts\activate.bat" ^&^& python -m uvicorn server:app --host 0.0.0.0 --port 8000

echo Waiting for FastAPI Agent to accept connections on port 8000...
set "AGENT_READY="
for /l %%i in (1,1,20) do (
    powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8000/api/health -TimeoutSec 2; if ($r.StatusCode -ge 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
        set "AGENT_READY=1"
        goto :agent_ready
    )
    timeout /t 1 /nobreak >nul
)

:agent_ready
if not defined AGENT_READY (
    echo Warning: FastAPI Agent did not report healthy within timeout. CopilotKit may see a temporary ECONNREFUSED until port 8000 is ready.
)

echo [4/5] Starting CopilotKit Runtime ^(Port 5000^)...
start "CopilotKit Runtime [%TARGET_BRANCH%]" cmd /k cd /d "%CODE_ROOT%runtime" ^&^& npm start

timeout /t 3 /nobreak >nul

echo [5/5] Starting React Frontend ^(Port 3000^)...
start "React Frontend [%TARGET_BRANCH%]" cmd /k cd /d "%CODE_ROOT%frontend" ^&^& npm start

echo.
echo ==========================================
echo All services started for branch %TARGET_BRANCH%.
echo ------------------------------------------
echo Flask Backend:      http://localhost:5001
echo FastAPI Agent:      http://localhost:8000
echo CopilotKit Runtime: http://localhost:5000
echo React Frontend:     http://localhost:3000
echo ==========================================
echo.
echo Press any key to close this window...
pause >nul
