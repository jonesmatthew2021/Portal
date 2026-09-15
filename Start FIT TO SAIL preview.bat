@echo off
rem Starts the preview of Christopher's FIT TO SAIL (CREWCOMP) on this laptop, so
rem the portal's FIT TO SAIL button has somewhere to go during a demonstration.
rem Two windows open: the backend (takes about a minute to be ready) and the web
rem app. Close both windows to stop it.
rem Needs the local PostgreSQL service running (it starts with Windows).
rem
rem The web app is also served to other devices on the same Wi-Fi (or this
rem laptop's hotspot), so a phone can open it at the address printed below and
rem add it to its home screen. The first time, Windows asks whether to allow
rem Node.js through the firewall - click Allow (private networks).

rem The attest repo is expected beside this folder (see SETUP.md).
set "ATTEST=%~dp0..\attest"
rem Use the Java already on this machine if JAVA_HOME is set; otherwise the
rem Microsoft build of JDK 21 in its usual place.
if not defined JAVA_HOME set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "QUARKUS_DATASOURCE_JDBC_URL=jdbc:postgresql://localhost:5432/crewcomp"
set "QUARKUS_DATASOURCE_USERNAME=postgres"
set "QUARKUS_DATASOURCE_PASSWORD=postgres"
set "CREWCOMP_MCP_TOKEN=local-dev-token-for-fit-to-sail-preview-0123456789"

rem The two windows inherit the settings above.
start "FIT TO SAIL backend" /d "%ATTEST%\backend" cmd /k mvnw.cmd quarkus:dev
start "FIT TO SAIL web" /d "%ATTEST%\admin-web" cmd /k npm.cmd run dev -- --host

echo.
echo FIT TO SAIL preview starting. Give the backend window about a minute.
echo.
echo   On this laptop:  press the FIT TO SAIL button in the portal, or open http://localhost:5173
echo   On your phone:   same Wi-Fi as this laptop, then open one of these addresses:
for /f "tokens=2 delims=:" %%A in ('ipconfig ^| findstr /c:"IPv4"') do (
  for /f "tokens=* delims= " %%B in ("%%A") do echo                    http://%%B:5173
)
echo                    then Chrome menu ^> "Add to Home screen" for an app icon.
echo.
echo Close both windows when the demonstration is over.
pause
