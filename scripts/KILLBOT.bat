@echo off
echo === Stoppe alle Node.js Prozesse ===
taskkill /F /IM node.exe /T
echo.
echo === Fertig - lokaler Bot gestoppt ===
timeout /t 3
