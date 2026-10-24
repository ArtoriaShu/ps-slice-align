$ErrorActionPreference = 'Stop'
$taskDest = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.align4.export'
if (Test-Path -LiteralPath $taskDest) { Remove-Item -LiteralPath $taskDest -Recurse -Force }
Write-Host 'The Align4 extension has been removed. Restart Photoshop.'
Write-Host 'Shared CEP PlayerDebugMode settings are kept to avoid affecting other extensions.'
