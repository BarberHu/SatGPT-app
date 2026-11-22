param(
    [string]$OutputDir = "",
    [string]$PythonVersion = "3.12.10",
    [switch]$SkipFrontendBuild,
    [switch]$RefreshWheels
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = (Resolve-Path (Join-Path $ScriptDir "..\..\..")).Path
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $RootDir "dist\SatGPT-Windows-Offline"
}
$CacheDir = Join-Path $RootDir "dist\.installer-cache"
$PythonCacheDir = Join-Path $CacheDir "python"
$WheelCacheDir = Join-Path $CacheDir "wheels-py$PythonVersion"

$CscExe = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $CscExe)) {
    throw "Cannot find .NET Framework C# compiler at $CscExe"
}

$VenvPython = Join-Path $RootDir "harness\.venv\Scripts\python.exe"
$PythonExe = if (Test-Path $VenvPython) { $VenvPython } else { (Get-Command python -ErrorAction Stop).Source }
$NodeExe = (Get-Command node -ErrorAction Stop).Source

Write-Host "[1/6] Preparing output & cache directories..."
New-Item -ItemType Directory -Force -Path $PythonCacheDir, $WheelCacheDir | Out-Null
if (Test-Path $OutputDir) {
    Remove-Item -Path $OutputDir -Recurse -Force
}
$PayloadDir = Join-Path $OutputDir "payload"
$AppOut = Join-Path $PayloadDir "app"
$PythonOut = Join-Path $PayloadDir "python"
$WheelsOut = Join-Path $PayloadDir "wheels"
$NodeOut = Join-Path $PayloadDir "node"
$FrontendOut = Join-Path $PayloadDir "frontend"
$LauncherOut = Join-Path $PayloadDir "launcher"
New-Item -ItemType Directory -Force -Path $AppOut, $PythonOut, $WheelsOut, $NodeOut, $FrontendOut, $LauncherOut | Out-Null

# 2. Frontend production build
if (-not $SkipFrontendBuild) {
    Write-Host "[2/6] Building production frontend assets..."
    & cmd.exe /c (Join-Path $RootDir "scripts\windows\build_production.bat")
    if ($LASTEXITCODE -ne 0) {
        throw "Frontend production build failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "[2/6] Skipping frontend build (using existing frontend\build)..."
}
if (-not (Test-Path (Join-Path $RootDir "frontend\build\index.html"))) {
    throw "Missing frontend\build\index.html. Run build first."
}

# 3. Collect clean SatGPT app files (excluding secrets, state, venv, tests, caches)
Write-Host "[3/6] Collecting SatGPT application files (no secrets/state/venv)..."
$RootFiles = @(
    "satgpt_backend.py",
    "satgpt_config.py",
    "requirements.txt",
    ".env.example",
    "PRODUCTION.md",
    "README.md",
    "README.zh-CN.md"
)
foreach ($rf in $RootFiles) {
    $src = Join-Path $RootDir $rf
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $AppOut $rf) -Force
    }
}

function Copy-CleanTree {
    param([string]$Source, [string]$Dest, [string[]]$ExcludeDirs)
    $srcFull = (Resolve-Path $Source).Path.TrimEnd('\')
    $files = Get-ChildItem -Path $srcFull -Recurse -File
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($srcFull.Length + 1)
        $parts = $rel.Split('\')
        $skip = $false
        foreach ($p in $parts) {
            if ($ExcludeDirs -contains $p) { $skip = $true; break }
        }
        if ($skip) { continue }
        if ($f.Extension -in @('.pyc', '.pyo')) { continue }
        $dstFile = Join-Path $Dest $rel
        $dstParent = Split-Path -Parent $dstFile
        if (-not (Test-Path $dstParent)) {
            New-Item -ItemType Directory -Force -Path $dstParent | Out-Null
        }
        Copy-Item -Path $f.FullName -Destination $dstFile -Force
    }
}

Copy-CleanTree -Source (Join-Path $RootDir "basic") -Dest (Join-Path $AppOut "basic") -ExcludeDirs @("__pycache__", ".pytest_cache", "tests")
Copy-CleanTree -Source (Join-Path $RootDir "harness") -Dest (Join-Path $AppOut "harness") -ExcludeDirs @("__pycache__", ".venv", "state", "tests", ".pytest_cache", "node_modules")

# Frontend runtime files & portable node.exe (no node_modules needed)
Copy-Item -Path $NodeExe -Destination (Join-Path $NodeOut "node.exe") -Force
Copy-CleanTree -Source (Join-Path $RootDir "frontend\build") -Dest (Join-Path $FrontendOut "build") -ExcludeDirs @()
foreach ($ff in @("server.cjs", "projectEnv.cjs", "package.json")) {
    $src = Join-Path $RootDir "frontend\$ff"
    if (Test-Path $src) {
        Copy-Item -Path $src -Destination (Join-Path $FrontendOut $ff) -Force
    }
}

# 4. Prepare embedded Python 3.12 zip
Write-Host "[4/6] Preparing portable Python $PythonVersion embeddable package..."
$PyZipName = "python-$PythonVersion-embed-amd64.zip"
$PyZipCache = Join-Path $PythonCacheDir $PyZipName
if (-not (Test-Path $PyZipCache)) {
    $PyUrl = "https://www.python.org/ftp/python/$PythonVersion/$PyZipName"
    Write-Host "      Downloading $PyUrl ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $PyUrl -OutFile $PyZipCache -UseBasicParsing
}
Copy-Item -Path $PyZipCache -Destination (Join-Path $PythonOut $PyZipName) -Force

# 5. Prepare full offline wheels (pip + requirements.txt)
Write-Host "[5/6] Preparing offline Python wheels..."
$ReqHashFile = Join-Path $WheelCacheDir ".req-hash.txt"
$ReqHash = (Get-FileHash (Join-Path $RootDir "requirements.txt") -Algorithm SHA256).Hash
$CachedWheels = @(Get-ChildItem -Path $WheelCacheDir -Filter "*.whl" -ErrorAction SilentlyContinue)
$HasPipWheel = @(Get-ChildItem -Path $WheelCacheDir -Filter "pip-*.whl" -ErrorAction SilentlyContinue).Count -gt 0
$CacheValid = (-not $RefreshWheels) -and $HasPipWheel -and ($CachedWheels.Count -gt 20) -and (Test-Path $ReqHashFile) -and ((Get-Content $ReqHashFile -Raw).Trim() -eq $ReqHash)

if (-not $CacheValid) {
    Get-ChildItem -Path $WheelCacheDir -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
    Write-Host "      Downloading pip wheel..."
    & $PythonExe -m pip download --only-binary=:all: -d $WheelCacheDir pip
    if ($LASTEXITCODE -ne 0) { throw "Failed to download pip wheel" }

    Write-Host "      Downloading requirements.txt wheels..."
    & $PythonExe -m pip download --prefer-binary -d $WheelCacheDir -r (Join-Path $RootDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Failed to download requirements.txt wheels" }

    Set-Content -Path $ReqHashFile -Value $ReqHash -NoNewline
} else {
    Write-Host "      Reusing cached offline wheels ($($CachedWheels.Count) files)."
}

Copy-Item -Path (Join-Path $WheelCacheDir "*.whl") -Destination $WheelsOut -Force
$ExtraArchives = Get-ChildItem -Path $WheelCacheDir -Include "*.tar.gz","*.zip" -File -ErrorAction SilentlyContinue
foreach ($arc in $ExtraArchives) {
    Copy-Item -Path $arc.FullName -Destination $WheelsOut -Force
}

# 6. Compile native Windows .exe installer & launcher
Write-Host "[6/6] Compiling SatGPT-Setup.exe and SatGPT-Launcher.exe..."
$SetupOut = Join-Path $OutputDir "SatGPT-Setup.exe"
$LauncherExeOut = Join-Path $LauncherOut "SatGPT-Launcher.exe"

& $CscExe /nologo /optimize+ /utf8output /target:winexe `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /r:System.IO.Compression.dll `
    /r:System.IO.Compression.FileSystem.dll `
    /out:$SetupOut `
    (Join-Path $ScriptDir "SatGPTSetup.cs")
if ($LASTEXITCODE -ne 0) { throw "Failed to compile SatGPTSetup.cs" }

& $CscExe /nologo /optimize+ /utf8output /target:winexe `
    /r:System.Windows.Forms.dll `
    /r:System.Drawing.dll `
    /out:$LauncherExeOut `
    (Join-Path $ScriptDir "SatGPTLauncher.cs")
if ($LASTEXITCODE -ne 0) { throw "Failed to compile SatGPTLauncher.cs" }

# Summary
$WheelFiles = @(Get-ChildItem -Path $WheelsOut -File)
$TotalBytes = (Get-ChildItem -Path $OutputDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$TotalMB = [Math]::Round($TotalBytes / 1MB, 2)
$SetupKB = [Math]::Round((Get-Item $SetupOut).Length / 1KB, 1)
$LauncherKB = [Math]::Round((Get-Item $LauncherExeOut).Length / 1KB, 1)

Write-Host ""
Write-Host "=========================================================="
Write-Host " SatGPT Windows Offline Bundle Built Successfully"
Write-Host " Output:       $OutputDir"
Write-Host " Setup EXE:    SatGPT-Setup.exe ($SetupKB KB)"
Write-Host " Launcher EXE: payload\launcher\SatGPT-Launcher.exe ($LauncherKB KB)"
Write-Host " Wheels:       $($WheelFiles.Count) package files"
Write-Host " Total Size:   $TotalMB MB"
Write-Host "=========================================================="
