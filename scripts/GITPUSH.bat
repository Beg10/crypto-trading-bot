@echo off
echo === Git Push: Monitoring Update ===

:: Delete stale lock file if exists
if exist ".git\index.lock" (
    del /F ".git\index.lock"
    echo Lock file removed.
)

git config user.email "beg.22.sh@gmail.com"
git config user.name "Beg10"
git add src/bot.ts src/worker.ts
git commit -m "feat: add monitoring - startup/crash notifications to admin"
git push

echo.
echo === Fertig! Railway deployed automatisch. ===
timeout /t 5
