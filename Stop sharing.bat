@echo off
title Stop sharing the portal

net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

tailscale serve reset
echo.
echo Sharing is off. The folder is no longer reachable over Tailscale.
echo.
pause
