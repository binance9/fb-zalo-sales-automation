@echo off
rem ============================================================
rem MO-BOT.bat — Icon desktop: mo bot ban hang (click-la-chay)
rem - Port 8080 con song -> mo browser luon (khong nhan doi server)
rem - Chua chay -> khoi dong server (persist, khong demo) roi mo browser
rem ============================================================
cd /d "%~dp0"
set UI_DEMO=0
set APP_DATA_MODE=persist
set NO_BROWSER_OPEN=1
netstat -ano | findstr ":8080" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 goto open
start "BotBanHang" /min cmd /c "node run-sales.js > run-sales.log 2>&1"
timeout /t 2 /nobreak >nul
:open
start "" http://localhost:8080
exit
