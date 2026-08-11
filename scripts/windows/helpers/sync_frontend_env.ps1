param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
)

$rootEnvPath = Join-Path $RootDir ".env"
$frontendEnvPath = Join-Path $RootDir "frontend\.env.local"

if (-not (Test-Path $rootEnvPath)) {
    Write-Error "Root .env not found: $rootEnvPath"
    exit 1
}

$envMap = @{}
Get-Content $rootEnvPath | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        $envMap[$matches[1]] = $matches[2]
    }
}

function Get-EnvValue {
    param(
        [string[]]$Names,
        [string]$Default = ""
    )

    foreach ($name in $Names) {
        if ($envMap.ContainsKey($name) -and $envMap[$name] -ne "") {
            return $envMap[$name]
        }
    }

    return $Default
}

$frontendHost = Get-EnvValue -Names @("FRONTEND_HOST") -Default "0.0.0.0"
$frontendPort = Get-EnvValue -Names @("FRONTEND_PORT") -Default "3000"
$publicHost = Get-EnvValue -Names @("SATGPT_PUBLIC_HOST") -Default "localhost"
$serviceHost = Get-EnvValue -Names @("SATGPT_SERVICE_HOST") -Default "127.0.0.1"
$agentPort = Get-EnvValue -Names @("AGENT_PORT") -Default "8000"
$runtimePort = Get-EnvValue -Names @("RUNTIME_PORT") -Default "5000"

$defaultCopilotkitUrl = "/copilotkit"

$content = @(
    "# Auto-generated from the repository root .env",
    "# Edit the root .env, then rerun scripts\windows\start_windows.bat",
    "HOST=${frontendHost}",
    "PORT=${frontendPort}",
    "SATGPT_PUBLIC_HOST=${publicHost}",
    "SATGPT_SERVICE_HOST=${serviceHost}",
    "AGENT_PORT=${agentPort}",
    "RUNTIME_PORT=${runtimePort}",
    "GENERATE_SOURCEMAP=$(Get-EnvValue -Names @('GENERATE_SOURCEMAP') -Default 'false')",
    "REACT_APP_MAPBOX_ACCESS_KEY=$(Get-EnvValue -Names @('REACT_APP_MAPBOX_ACCESS_KEY'))",
    "REACT_APP_API_URL=$(Get-EnvValue -Names @('REACT_APP_API_URL'))",
    "REACT_APP_COPILOTKIT_URL=$(Get-EnvValue -Names @('REACT_APP_COPILOTKIT_URL') -Default $defaultCopilotkitUrl)"
)

[System.IO.File]::WriteAllLines(
    $frontendEnvPath,
    $content,
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Synced frontend public env to $frontendEnvPath"
