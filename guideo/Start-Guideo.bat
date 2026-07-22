@echo off
setlocal enableextensions
cd /d "%~dp0"
title Guideo

where node >nul 2>nul
if errorlevel 1 goto NONODE

if not exist "node_modules\" goto INSTALL
goto RUN

:INSTALL
echo.
echo   First run: installing Guideo (one-time, this can take a minute or two)...
echo.
call npm install
if errorlevel 1 goto INSTALLFAIL
goto RUN

:RUN
echo.
echo   Starting Guideo... your browser will open at http://127.0.0.1:4600
echo   Keep this window open while you use Guideo. Close it (or press Ctrl-C) to stop.
echo.
call npm run gui
echo.
echo   Guideo has stopped.
goto END

:NONODE
echo.
echo   Node.js is required but was not found on this PC.
echo   1. Install the LTS version from https://nodejs.org
echo   2. Then double-click Start-Guideo.bat again.
goto END

:INSTALLFAIL
echo.
echo   The one-time dependency install failed.
echo   Check your internet connection, then run Start-Guideo.bat again.
goto END

:END
echo.
pause
