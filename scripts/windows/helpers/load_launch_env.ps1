param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir
)

$rootEnvPath = Join-Path $RootDir ".env"

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

function Get-OptionalEnvValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if (-not $envMap.ContainsKey($Name)) {
        return ""
    }

    return $envMap[$Name].Trim().Trim("'`"")
}

$values = [ordered]@{
    SATGPT_SERVICE_HOST = Get-RequiredEnvValue -Name "SATGPT_SERVICE_HOST"
    AGENT_HOST = Get-RequiredEnvValue -Name "AGENT_HOST"
    AGENT_PORT = Get-RequiredEnvValue -Name "AGENT_PORT"
    AGENT_DEBUG = Get-RequiredEnvValue -Name "AGENT_DEBUG"
    AGENT_WORKERS = Get-RequiredEnvValue -Name "AGENT_WORKERS"
    FORWARDED_ALLOW_IPS = Get-RequiredEnvValue -Name "FORWARDED_ALLOW_IPS"
    RUNTIME_HOST = Get-RequiredEnvValue -Name "RUNTIME_HOST"
    RUNTIME_PORT = Get-RequiredEnvValue -Name "RUNTIME_PORT"
    FRONTEND_HOST = Get-RequiredEnvValue -Name "FRONTEND_HOST"
    FRONTEND_PORT = Get-RequiredEnvValue -Name "FRONTEND_PORT"
    PROXY_TIMEOUT_MS = Get-RequiredEnvValue -Name "PROXY_TIMEOUT_MS"
    PROXY_MAX_SOCKETS = Get-RequiredEnvValue -Name "PROXY_MAX_SOCKETS"
    HTTP_PROXY = Get-OptionalEnvValue -Name "HTTP_PROXY"
    HTTPS_PROXY = Get-OptionalEnvValue -Name "HTTPS_PROXY"
}

foreach ($entry in $values.GetEnumerator()) {
    Write-Output ("{0}={1}" -f $entry.Key, $entry.Value)
}
