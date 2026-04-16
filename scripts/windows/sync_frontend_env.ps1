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

$publicHost = Get-EnvValue -Names @("SATGPT_PUBLIC_HOST") -Default "localhost"
$flaskPort = Get-EnvValue -Names @("FLASK_RUN_PORT") -Default "5001"
$agentPort = Get-EnvValue -Names @("AGENT_PORT", "PORT") -Default "8000"
$runtimePort = Get-EnvValue -Names @("RUNTIME_PORT") -Default "5000"
$frontendHost = Get-EnvValue -Names @("FRONTEND_HOST") -Default "0.0.0.0"
$frontendPort = Get-EnvValue -Names @("FRONTEND_PORT") -Default "3000"

$defaultFlaskProxyTarget = "http://${publicHost}:${flaskPort}"
$defaultAgentApiUrl = "http://${publicHost}:${agentPort}"
$defaultRuntimeProxyTarget = "http://${publicHost}:${runtimePort}"
$defaultCopilotkitUrl = "${defaultRuntimeProxyTarget}/copilotkit"

$content = @(
    "# Auto-generated from the repository root .env",
    "# Edit the root .env, then rerun scripts\windows\start_windows.bat",
    "HOST=${frontendHost}",
    "PORT=${frontendPort}",
    "GENERATE_SOURCEMAP=$(Get-EnvValue -Names @('GENERATE_SOURCEMAP') -Default 'false')",
    "REACT_APP_MAPBOX_ACCESS_KEY=$(Get-EnvValue -Names @('REACT_APP_MAPBOX_ACCESS_KEY', 'MAPBOX_ACCESS_KEY'))",
    "REACT_APP_API_URL=$(Get-EnvValue -Names @('REACT_APP_API_URL'))",
    "REACT_APP_FLASK_PROXY_TARGET=$(Get-EnvValue -Names @('REACT_APP_FLASK_PROXY_TARGET') -Default $defaultFlaskProxyTarget)",
    "REACT_APP_AGENT_API_URL=$(Get-EnvValue -Names @('REACT_APP_AGENT_API_URL') -Default $defaultAgentApiUrl)",
    "REACT_APP_COPILOTKIT_PROXY_TARGET=$(Get-EnvValue -Names @('REACT_APP_COPILOTKIT_PROXY_TARGET') -Default $defaultRuntimeProxyTarget)",
    "REACT_APP_COPILOTKIT_URL=$(Get-EnvValue -Names @('REACT_APP_COPILOTKIT_URL') -Default $defaultCopilotkitUrl)"
)

Set-Content -Path $frontendEnvPath -Value $content -Encoding UTF8
Write-Host "Synced frontend public env to $frontendEnvPath"
