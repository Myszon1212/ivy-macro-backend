@echo off
title Ivy Macro Cloud - Server
echo ==============================================
echo Sprawdzanie i zwalnianie portu 3000...
echo ==============================================
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000') do (
    taskkill /f /pid %%a >nul 2>&1
)

echo Uruchamianie serwera Ivy Macro Cloud...
echo ==============================================
node server.js
pause
