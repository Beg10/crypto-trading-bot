@echo off
echo.
echo ========================================
echo   MarketLens Website -- Netlify Deploy
echo ========================================
echo.

cd /d "%~dp0"

where netlify >nul 2>&1
if %errorlevel% neq 0 (
  echo [1/3] Netlify CLI wird installiert...
  npm install -g netlify-cli
) else (
  echo [1/3] Netlify CLI bereits installiert.
)

echo.
echo [2/3] Login bei Netlify (Browser oeffnet sich)...
netlify login

echo.
echo [3/3] Deploy...
netlify deploy --prod --dir website --message "MarketLens website deploy"

echo.
echo Fertig! Deine URL steht oben.
pause
