@echo off
rem Starts the preview of Christopher's FIT TO SAIL (CREWCOMP) on this laptop, so
rem the portal's FIT TO SAIL button has somewhere to go during a demonstration.
rem Two windows open: the backend (takes about a minute to be ready) and the web
rem app (http://localhost:5173). Close both windows to stop it.
rem Needs the local PostgreSQL service running (it starts with Windows).

set "ATTEST=C:\Users\jones\OneDrive\Desktop\attest"
set "JAVA_HOME=C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot"
set "PATH=%JAVA_HOME%\bin;%PATH%"
set "QUARKUS_DATASOURCE_JDBC_URL=jdbc:postgresql://localhost:5432/crewcomp"
set "QUARKUS_DATASOURCE_USERNAME=postgres"
set "QUARKUS_DATASOURCE_PASSWORD=postgres"
set "CREWCOMP_MCP_TOKEN=local-dev-token-for-fit-to-sail-preview-0123456789"

rem The two windows inherit the settings above.
start "FIT TO SAIL backend" /d "%ATTEST%\backend" cmd /k mvnw.cmd quarkus:dev
start "FIT TO SAIL web" /d "%ATTEST%\admin-web" cmd /k npm.cmd run dev

echo.
echo FIT TO SAIL preview starting. Give the backend window about a minute,
echo then press the FIT TO SAIL button in the portal (or open http://localhost:5173).
echo Close both windows when the demonstration is over.
pause
