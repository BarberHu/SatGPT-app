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

$values = [ordered]@{
    SATGPT_PUBLIC_HOST = Get-EnvValue -Names @("SATGPT_PUBLIC_HOST") -Default "localhost"
    SATGPT_SERVICE_HOST = Get-EnvValue -Names @("SATGPT_SERVICE_HOST") -Default "127.0.0.1"
    SATGPT_HTTP_PROXY = Get-EnvValue -Names @("SATGPT_HTTP_PROXY", "HTTP_PROXY", "HTTPS_PROXY") -Default ""
    AGENT_HOST = Get-EnvValue -Names @("AGENT_HOST") -Default "0.0.0.0"
    AGENT_PORT = Get-EnvValue -Names @("AGENT_PORT") -Default "8000"
    AGENT_DEBUG = Get-EnvValue -Names @("AGENT_DEBUG") -Default "True"
    RUNTIME_HOST = Get-EnvValue -Names @("RUNTIME_HOST") -Default "0.0.0.0"
    RUNTIME_PORT = Get-EnvValue -Names @("RUNTIME_PORT") -Default "5000"
    FRONTEND_HOST = Get-EnvValue -Names @("FRONTEND_HOST") -Default "0.0.0.0"
    FRONTEND_PORT = Get-EnvValue -Names @("FRONTEND_PORT") -Default "3000"
}

foreach ($entry in $values.GetEnumerator()) {
    Write-Output ("{0}={1}" -f $entry.Key, $entry.Value)
}
