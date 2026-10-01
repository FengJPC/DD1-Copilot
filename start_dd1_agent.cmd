@echo off
setlocal
title DD1 Agent Launcher

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start_agent_game.ps1" %*
set "launch_exit=%ERRORLEVEL%"

if not "%launch_exit%"=="0" (
    echo.
    echo DD1 Agent failed to start. Error code: %launch_exit%
    echo Keep this window open and send the error above to GPT.
    pause
    exit /b %launch_exit%
)

echo.
echo DD1 Agent launcher completed.
timeout /t 5 /nobreak >nul 2>nul
exit /b 0
