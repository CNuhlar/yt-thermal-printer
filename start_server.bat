@echo off
cd /d "%~dp0"
title yt-printer server
python yt_printer.py --serve
echo.
echo Server stopped. Press any key to close this window.
pause >nul
