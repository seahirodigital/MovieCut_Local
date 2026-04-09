@echo off
setlocal

cd /d "%~dp0"

set "BOOTSTRAP=python"
where python >nul 2>nul
if errorlevel 1 (
    where py >nul 2>nul
    if errorlevel 1 (
        echo Python was not found.
        pause
        exit /b 1
    )
    set "BOOTSTRAP=py -3"
)

if not exist "venv\Scripts\python.exe" (
    echo Creating virtual environment...
    %BOOTSTRAP% -m venv venv
    if errorlevel 1 (
        echo Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo Installing dependencies...
venv\Scripts\python.exe -m pip install -r requirements.txt -q
if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo Starting automatic batch export...
venv\Scripts\python.exe "%~dp0auto_export_batch.py"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Finished with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
