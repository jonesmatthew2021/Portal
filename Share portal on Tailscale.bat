@echo off
title Share the portal on Tailscale

rem Sharing a folder path needs administrator rights on Windows - if we don't
rem have them yet, relaunch this same script elevated (Windows will ask Yes/No).
net session >nul 2>&1
if errorlevel 1 (
  echo Asking Windows for administrator permission...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Sharing this folder with your tailnet (private, HTTPS)...
echo.
tailscale serve --bg "%~dp0."
if errorlevel 1 (
  echo.
  echo Tailscale couldn't start sharing. Check that Tailscale is installed,
  echo running, and signed in - then double-click this again.
  echo.
  pause
  exit /b 1
)
echo.
echo ================= SHARING IS ON =================
tailscale serve status
echo.
echo Open the https address shown above and add  /preview.html
echo Example:  https://your-pc.your-tailnet.ts.net/preview.html
echo.
echo Anyone on your tailnet can open that address. Nobody on the
echo public internet can - this is tailnet-only.
echo.
echo To stop sharing, double-click "Stop sharing.bat".
echo.
pause
