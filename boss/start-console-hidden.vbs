' start-console-hidden.vbs - launch BOSS console with NO visible window.
' Used by the BossConsole scheduled task (and optionally the Startup shortcut).
' ASCII-only: wscript parses VBS in the ANSI codepage.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\github\career-ops"
sh.Run "cmd /c ""D:\github\career-ops\boss\start-console.cmd"" /noopen", 0, False
