@echo off
rem start-console.cmd - BOSS web console one-click launcher (Windows)
rem Usage: double-click the desktop shortcut, or run this file directly.
rem Optional arg: /noopen  - do not open the browser tab (for autostart)
rem NOTE: keep this file ASCII-only. cmd.exe parses batch files in the ANSI
rem       codepage (GBK on zh-CN systems); UTF-8 Chinese comments break parsing.

cd /d "%~dp0.."

set NOOPEN=
if /i "%~1"=="/noopen" set NOOPEN=1

rem UTF-8 console codepage: keeps the Chinese log lines from turning into mojibake.
chcp 65001 >nul 2>&1

set "LOGDIR=%~dp0boss-web"
set "LOGFILE=%LOGDIR%\console.log"

rem Skip if already running (avoid port conflict)
netstat -ano | findstr /r /c:":4173 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [i] Console already running - opening page...
  if not defined NOOPEN start "" http://127.0.0.1:4173
  timeout /t 2 >nul
  exit /b 0
)

rem An explicit start clears a previous "stop" (see stop-console.cmd / watchdog-console.vbs).
del /q "%LOGDIR%\.stopped" >nul 2>&1

rem PostgreSQL credentials: loaded from boss\.env.local (gitignored, not in repo).
rem pg-db.mjs also auto-loads this file; exporting here keeps child scripts consistent.
rem Create it once:  PGHOST=127.0.0.1 / PGUSER=root / PGPASSWORD=yourpassword / PGDATABASE=career_ops
if exist "%~dp0.env.local" for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "PGHOST= PGPORT= PGUSER= PGPASSWORD= PGDATABASE=" "%~dp0.env.local"`) do set "%%A=%%B"
if not defined PGPASSWORD (
  echo [!] PGPASSWORD not set. Create boss\.env.local with PostgreSQL credentials - see boss/README.md.
  pause
  exit /b 1
)

rem Keep the last ~5 MB of output, rotate the rest to console.log.1
if exist "%LOGFILE%" for %%F in ("%LOGFILE%") do if %%~zF GTR 5242880 move /y "%LOGFILE%" "%LOGFILE%.1" >nul 2>&1

echo [i] Starting BOSS console: http://127.0.0.1:4173  (close this window to stop)
if not defined NOOPEN start "" http://127.0.0.1:4173
rem Every exit path now leaves a trace in boss/boss-web/console.log - without this the
rem process used to vanish silently and there was no way to tell why it died.
echo ===== %date% %time% start =====>>"%LOGFILE%"
node boss\boss-web\server.mjs >>"%LOGFILE%" 2>&1
set "EXITCODE=%errorlevel%"
echo ===== %date% %time% exit code=%EXITCODE% =====>>"%LOGFILE%"
exit /b %EXITCODE%
