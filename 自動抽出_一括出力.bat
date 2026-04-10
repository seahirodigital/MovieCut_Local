@echo off
setlocal

cd /d "%~dp0"

set "BOOTSTRAP=python"
set "VENV_DIR=venv-win"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
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

if exist "%VENV_DIR%\pyvenv.cfg" (
    findstr /I /C:"/Library/Developer/CommandLineTools/usr/bin" "%VENV_DIR%\pyvenv.cfg" >nul 2>nul
    if not errorlevel 1 (
        echo Detected broken virtual environment metadata in %VENV_DIR%.
        echo Please remove %VENV_DIR% manually and run again.
        pause
        exit /b 1
    )
)

if not exist "%VENV_PYTHON%" (
    echo Creating Windows virtual environment in %VENV_DIR%...
    %BOOTSTRAP% -m venv "%VENV_DIR%" --without-pip
    if errorlevel 1 (
        echo Failed to create virtual environment.
        pause
        exit /b 1
    )
)

echo Installing dependencies...
%BOOTSTRAP% -m pip --python "%VENV_DIR%" install -r requirements.txt -q
if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
)

echo.
echo Starting automatic batch export...
%VENV_PYTHON% "%~dp0auto_export_batch.py"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Finished with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
