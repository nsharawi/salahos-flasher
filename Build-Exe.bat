@echo off
rem Builds the single-file Salah OS Flasher .exe into the dist folder.
cd /d "%~dp0"
echo Installing build tools (first run downloads about 300 MB)...
call npm install
if errorlevel 1 goto :fail
echo Building the .exe ...
call npx electron-builder --win portable
if errorlevel 1 goto :fail
echo.
echo Done. The .exe is in the dist folder:
dir /b dist\*.exe
goto :end
:fail
echo.
echo BUILD FAILED - copy the text above and send it to Claude.
:end
pause
