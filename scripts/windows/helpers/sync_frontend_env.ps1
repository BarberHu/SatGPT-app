param([Parameter(Mandatory = $true)][string]$RootDir)

$source = Join-Path $RootDir ".env"
$target = Join-Path $RootDir "frontend\.env.local"

if (-not (Test-Path $source)) {
    throw "Missing $source"
}

$values = @{}
foreach ($line in Get-Content $source) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
        $values[$matches[1]] = $matches[2].Trim().Trim([char[]](39, 34))
    }
}

$required = @(
    "FRONTEND_HOST",
    "FRONTEND_PORT",
    "SATGPT_SERVICE_HOST",
    "AGENT_PORT",
    "RUNTIME_PORT",
    "GENERATE_SOURCEMAP",
    "REACT_APP_MAPBOX_ACCESS_TOKEN",
    "REACT_APP_MAPBOX_STYLE_URL"
)

foreach ($name in $required) {
    if ([string]::IsNullOrWhiteSpace($values[$name])) {
        throw "Missing $name in $source"
    }
}

$content = @(
    "HOST=$($values.FRONTEND_HOST)"
    "PORT=$($values.FRONTEND_PORT)"
    "SATGPT_SERVICE_HOST=$($values.SATGPT_SERVICE_HOST)"
    "AGENT_PORT=$($values.AGENT_PORT)"
    "RUNTIME_PORT=$($values.RUNTIME_PORT)"
    "GENERATE_SOURCEMAP=$($values.GENERATE_SOURCEMAP)"
    "REACT_APP_MAPBOX_ACCESS_TOKEN=$($values.REACT_APP_MAPBOX_ACCESS_TOKEN)"
    "REACT_APP_MAPBOX_STYLE_URL=$($values.REACT_APP_MAPBOX_STYLE_URL)"
)

[System.IO.File]::WriteAllLines($target, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "Updated $target"
