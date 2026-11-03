@echo off
rem stop-console.cmd - stop the BOSS web console (kills only the process listening on 4173)
rem Drops a marker file so the watchdog does NOT bring the console straight back;
rem the next manual start (shortcut / start-console.cmd) or next logon clears it.
set "STOPPED=%~dp0boss-web\.stopped"
if not exist "%~dp0boss-web" mkdir "%~dp0boss-web" >nul 2>&1
type nul > "%STOPPED%" 2>nul
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:":4173 .*LISTENING"') do (
  echo Stopping console PID %%P ...
  taskkill /PID %%P /T /F >nul 2>&1
)
echo Done. Console stopped. Watchdog paused until the next manual start or logon.
