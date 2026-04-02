@echo off
echo ========================================
echo   Movie AutoCut - Startup Script
echo ========================================
echo.

if not exist "venv" (
    echo [*] Creating virtual environment...
    python -m venv venv
    echo [OK] Virtual environment created.
)

echo [*] Installing dependencies...
venv\Scripts\python.exe -m pip install -r requirements.txt -q

echo.
echo [*] Starting Server...
echo [*] Browser will open automatically.
echo [*] Press Ctrl+C to exit.
echo.
venv\Scripts\python.exe server.py

pause
