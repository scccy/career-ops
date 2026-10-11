@echo off
rem stop-console.cmd - stop the BOSS web console (kills only the process listening on 4173)
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r ":4173 .*LISTENING"') do (
  echo Stopping console PID %%P ...
  taskkill /PID %%P /T /F >nul 2>&1
)
echo Done. Console stopped.
