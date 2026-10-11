@echo off
rem ============================================================
rem TAT-BOT.bat — Tat server bot ban hang (chi dung process 8080)
rem Dung sau khi sua .env.live de restart: TAT-BOT -> MO-BOT
rem ============================================================
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8080" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
  set FOUND=1
)
if %FOUND%==1 (echo Da tat server bot ban hang.) else (echo Server khong dang chay.)
timeout /t 2 /nobreak >nul
