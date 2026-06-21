@echo off
cd /d "%~dp0"
git push --set-upstream origin main
if %errorlevel% neq 0 (
  echo FEHLER beim Push!
) else (
  echo Gepusht! GitHub Actions deployt jetzt.
)
pause
