' watchdog-console.vbs - keep the BOSS console (127.0.0.1:4173) alive.
' Started every 2 minutes by the BossConsoleWatchdog scheduled task:
'   - if the user explicitly stopped the console (boss\boss-web\.stopped exists), do nothing
'   - else, if nothing listens on 4173, launch the hidden launcher
' ASCII-only: wscript parses VBS in the ANSI codepage.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
sh.CurrentDirectory = "D:\github\career-ops"

If fso.FileExists("D:\github\career-ops\boss\boss-web\.stopped") Then
  WScript.Quit 0
End If

' Reuse the launcher's own port guard: findstr exits 0 only when 4173 is LISTENING.
code = sh.Run("cmd /c netstat -ano | findstr /r /c:"":4173 .*LISTENING"" >nul 2>&1", 0, True)
If code <> 0 Then
  sh.Run "wscript.exe ""D:\github\career-ops\boss\start-console-hidden.vbs""", 0, False
End If
