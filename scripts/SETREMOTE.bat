@echo off
cd /d "C:\Users\begsh\crypto-trading-bot"
echo === Remote setzen und pushen ===
git remote remove origin 2>nul
git remote add origin https://github.com/Beg10/crypto-trading-bot.git
git remote -v
git push -u origin master
echo.
echo === Verifikation: kein .env im Repo ===
gh api repos/Beg10/crypto-trading-bot/git/trees/HEAD --jq ".tree[].path"
echo.
echo === DONE ===
cmd /k
