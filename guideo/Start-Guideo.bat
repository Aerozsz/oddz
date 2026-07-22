@echo off
REM ===== Guideo one-click launcher (Windows) =====
REM Double-click this file to open the Guideo control panel in your browser.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required but was not found.
  echo   Install it from https://nodejs.org  (LTS is fine), then run this again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   First run: installing Guideo ^(this happens once, give it a minute^)...
  echo.
  call npm install
  if errorlevel 1 ( echo Install failed. & pause & exit /b 1 )
)

echo.
echo   Starting Guideo... your browser will open at http://127.0.0.1:4600
echo   Keep this window open while you use Guideo. Close it to stop.
echo.
call npm run gui
pause
