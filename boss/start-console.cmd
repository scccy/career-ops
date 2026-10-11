@echo off
rem start-console.cmd - BOSS web console one-click launcher (Windows)
rem Usage: double-click the desktop shortcut, or run this file directly.
rem Optional arg: /noopen  - do not open the browser tab (for autostart)
rem NOTE: keep this file ASCII-only. cmd.exe parses batch files in the ANSI
rem       codepage (GBK on zh-CN systems); UTF-8 Chinese comments break parsing.

cd /d "%~dp0.."

set NOOPEN=
if /i "%~1"=="/noopen" set NOOPEN=1

rem Skip if already running (avoid port conflict)
netstat -ano | findstr /r /c:":4173 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [i] Console already running - opening page...
  if not defined NOOPEN start "" http://127.0.0.1:4173
  timeout /t 2 >nul
  exit /b 0
)

rem MySQL password: loaded from boss\.env.local (gitignored, not in repo).
rem Create it once:  echo MYSQL_PASSWORD=yourpassword> boss\.env.local
if exist "%~dp0.env.local" for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b "MYSQL_PASSWORD=" "%~dp0.env.local"`) do set "%%A=%%B"
if not defined MYSQL_PASSWORD (
  echo [!] MYSQL_PASSWORD not set. Create boss\.env.local with:  MYSQL_PASSWORD=yourpassword
  pause
  exit /b 1
)

echo [i] Starting BOSS console: http://127.0.0.1:4173  (close this window to stop)
if not defined NOOPEN start "" http://127.0.0.1:4173
node boss\boss-web\server.mjs
