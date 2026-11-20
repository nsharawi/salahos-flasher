@echo off
rem Starts the Salah OS Flasher from this folder.
cd /d "%~dp0"
set E1=%~dp0node_modules\electron\dist\electron.exe
set E2=%USERPROFILE%\Downloads\salahos-flasher\salahos-flasher\node_modules\electron\dist\electron.exe
if exist "%E1%" ( start "" "%E1%" "%~dp0." & goto :eof )
if exist "%E2%" ( start "" "%E2%" "%~dp0." & goto :eof )
echo Electron was not found. Run "npm install" in this folder once, then start this again.
pause
