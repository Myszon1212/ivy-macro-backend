@echo off
title Ivy Macro Cloud - Setup
echo ==============================================
echo Instalacja pakietow serwera Macro Cloud...
echo ==============================================
call npm install
if %errorlevel% neq 0 (
    echo [Blad] Upewnij sie, ze masz zainstalowany Node.js!
    pause
    exit /b 1
)

echo.
echo ==============================================
echo Uruchamianie jednorazowej autoryzacji Google...
echo ==============================================
node setup_auth.js
pause
