$ErrorActionPreference = 'Stop'
$taskSource = Join-Path $PSScriptRoot 'com.align4.export'
$taskDestRoot = Join-Path $env:APPDATA 'Adobe\CEP\extensions'
$taskDest = Join-Path $taskDestRoot 'com.align4.export'
if (-not (Test-Path (Join-Path $taskSource 'CSXS\manifest.xml'))) {
    throw 'Please extract the entire ZIP first, then run install.bat.'
}
if ($taskDest.Contains('#')) { throw 'CEP does not support # in the installation path. Use a Windows account without # in its profile path.' }
New-Item -ItemType Directory -Path $taskDestRoot -Force | Out-Null
Copy-Item -LiteralPath $taskSource -Destination $taskDestRoot -Recurse -Force
foreach ($taskCepVersion in @(9,10,11,12)) {
    $taskRegistryPath = "HKCU:\Software\Adobe\CSXS.$taskCepVersion"
    New-Item -Path $taskRegistryPath -Force | Out-Null
    New-ItemProperty -Path $taskRegistryPath -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}
Write-Host 'Installed for current Windows user. No administrator access is needed.'
Write-Host 'Unsigned CEP extension loading is enabled for CSXS 9-12.'
Write-Host "Installed path: $taskDest"
Write-Host 'Close and restart Photoshop. Then open Window > Extensions (Legacy) > the new panel.'
