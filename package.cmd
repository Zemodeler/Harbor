@echo off
rem Build Harbor and produce the Windows installer in dist\. Runs checks first; stops on the first failure.
cd /d "%~dp0"
call npm test || exit /b 1
call npm run typecheck || exit /b 1
call npm run dist || exit /b 1
echo.
echo Installer(s):
dir /b dist\*.exe
