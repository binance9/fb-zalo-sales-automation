@echo off
rem ============================================================
rem START-BOT.bat — chay San pham click-la-chay (Windows)
rem - Persist mode: du lieu GIU NGUYEN giua cac lan chay (db.json + db.backup.json)
rem - Sau 3 giay tu mo browser http://localhost:8080
rem ============================================================
cd /d "%~dp0"
set APP_DATA_MODE=persist
set UI_DEMO=0
set NO_BROWSER_OPEN=1
start "" /b cmd /c "timeout /t 3 /nobreak >nul & start "" http://localhost:8080"
node server.js
pause
