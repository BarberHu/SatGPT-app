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

function Get-RequiredEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not $envMap.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($envMap[$Name])) {
        throw "Missing required environment variable: $Name"
    }

    return $envMap[$Name].Trim().Trim("'`"")
}

$frontendHost = Get-RequiredEnvValue -Name "FRONTEND_HOST"
$frontendPort = Get-RequiredEnvValue -Name "FRONTEND_PORT"

$content = @(
    "# Auto-generated from the repository root .env",
    "# Edit the root .env, then rerun scripts\windows\start_windows.bat",
    "HOST=${frontendHost}",
    "PORT=${frontendPort}",
    "SATGPT_SERVICE_HOST=$(Get-RequiredEnvValue -Name 'SATGPT_SERVICE_HOST')",
    "AGENT_PORT=$(Get-RequiredEnvValue -Name 'AGENT_PORT')",
    "RUNTIME_PORT=$(Get-RequiredEnvValue -Name 'RUNTIME_PORT')",
    "GENERATE_SOURCEMAP=$(Get-RequiredEnvValue -Name 'GENERATE_SOURCEMAP')",
    "REACT_APP_MAPBOX_ACCESS_TOKEN=$(Get-RequiredEnvValue -Name 'REACT_APP_MAPBOX_ACCESS_TOKEN')",
    "REACT_APP_MAPBOX_STYLE_URL=$(Get-RequiredEnvValue -Name 'REACT_APP_MAPBOX_STYLE_URL')"
)

[System.IO.File]::WriteAllLines(
    $frontendEnvPath,
    $content,
    [System.Text.UTF8Encoding]::new($false)
)
Write-Host "Synced frontend public env to $frontendEnvPath"
