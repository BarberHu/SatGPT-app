param(
    [Parameter(Mandatory = $true)]
    [string]$Ports
)

$portList = $Ports -split "," |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ -match "^\d+$" } |
    ForEach-Object { [int]$_ } |
    Sort-Object -Unique

if (-not $portList) {
    Write-Error "No valid ports were provided."
    exit 1
}

$hasConflict = $false

foreach ($port in $portList) {
    $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $listeners) {
        continue
    }

    $hasConflict = $true
    Write-Host "[ERROR] Port $port is already in use."

    $listeners |
        Select-Object -ExpandProperty OwningProcess -Unique |
        ForEach-Object {
            $processId = $_
            $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
            if ($process) {
                Write-Host ("        PID:     {0}" -f $process.ProcessId)
                Write-Host ("        Process: {0}" -f $process.Name)
                Write-Host ("        Command: {0}" -f $process.CommandLine)
            } else {
                Write-Host ("        PID:     {0}" -f $processId)
                Write-Host "        Process: <not found>"
            }
        }
}

if ($hasConflict) {
    Write-Host ""
    Write-Host "Stop the conflicting process, or change AGENT_PORT / RUNTIME_PORT / FRONTEND_PORT in the root .env and rerun this script."
    exit 1
}

Write-Host "All configured ports are available: $($portList -join ', ')"
exit 0
