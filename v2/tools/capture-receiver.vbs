' 隐藏启动同目录的采集接收器（node capture-receiver.mjs），不弹出控制台窗口。
' 用法：双击本文件，或把它的快捷方式放进启动文件夹（Win+R 输入 shell:startup）。
Option Explicit

Dim fso, shell, baseDir, scriptPath, command, errCode
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(baseDir, "capture-receiver.mjs")

If Not fso.FileExists(scriptPath) Then
  MsgBox "找不到 capture-receiver.mjs，请让本文件与它位于同一目录。", 16, "采集接收器"
  WScript.Quit 1
End If

' 以脚本所在目录为工作目录，避免相对路径落到别处
shell.CurrentDirectory = baseDir
command = "node """ & scriptPath & """"

On Error Resume Next
' 0 = 隐藏窗口；False = 不等待退出
shell.Run command, 0, False
errCode = Err.Number
If errCode <> 0 Then
  MsgBox "启动失败，请确认已安装 Node.js 并在 PATH 中。" & vbCrLf & "错误码: " & errCode, 16, "采集接收器"
  WScript.Quit 1
End If
On Error GoTo 0
