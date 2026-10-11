@echo off
cd /d "%~dp0"
set UI_DEMO=0
set APP_DATA_MODE=persist
set NO_BROWSER_OPEN=1
node server.js > "%~dp0server-run.log" 2>&1
