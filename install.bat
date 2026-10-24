@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo Installation failed. Please read the message above.
) else (
  echo Restart Photoshop. Open Window ^> Extensions ^> 4-multiple PNG Export.
)
pause
