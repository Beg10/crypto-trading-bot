# deploy-setup.ps1
# Fuehrt alle Schritte fuer GitHub-Repo + ersten Push aus.
# Ausfuehren mit: powershell -ExecutionPolicy Bypass -File deploy-setup.ps1

Set-Location "C:\Users\begsh\crypto-trading-bot"

Write-Host "`n=== SCHRITT 1: gh CLI pruefen ===" -ForegroundColor Cyan
$ghVersion = gh --version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "gh CLI nicht gefunden. Installiere jetzt..." -ForegroundColor Yellow
    winget install --id GitHub.cli -e --source winget
    Write-Host "`nNach Installation: Starte dieses Skript erneut." -ForegroundColor Yellow
    exit 0
}
Write-Host "gh gefunden: $($ghVersion[0])" -ForegroundColor Green

Write-Host "`n=== SCHRITT 2: GitHub-Login pruefen ===" -ForegroundColor Cyan
$authStatus = gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Nicht eingeloggt. Starte Browser-Login..." -ForegroundColor Yellow
    gh auth login --hostname github.com --git-protocol https --web
}
else {
    Write-Host "Bereits eingeloggt." -ForegroundColor Green
}

Write-Host "`n=== SCHRITT 3: railway.json committen ===" -ForegroundColor Cyan
git add railway.json
git status

Write-Host "`n=== SCHRITT 4: Sicherheitscheck - .env NICHT im Index ===" -ForegroundColor Cyan
$envTracked = git ls-files .env
if ($envTracked) {
    Write-Host "ACHTUNG: .env ist im Git-Index! Entferne es..." -ForegroundColor Red
    git rm --cached .env
}
else {
    Write-Host ".env ist NICHT getrackt. Sicher!" -ForegroundColor Green
}

Write-Host "`n=== SCHRITT 5: Commit erstellen ===" -ForegroundColor Cyan
git commit -m "Add railway.json for Railway deploy"

Write-Host "`n=== SCHRITT 6: GitHub-Repo anlegen & pushen ===" -ForegroundColor Cyan
gh repo create crypto-trading-bot --private --source=. --remote=origin --push

Write-Host "`n=== SCHRITT 7: Verifikation ===" -ForegroundColor Cyan
Write-Host "Repo-Inhalt auf GitHub:" -ForegroundColor Cyan
gh repo view --json name,url,isPrivate | ConvertFrom-Json | Format-List

Write-Host "`nDateien im Repo (darf KEINE .env enthalten):" -ForegroundColor Cyan
gh api repos/$(gh api user --jq .login)/crypto-trading-bot/git/trees/HEAD --jq '.tree[].path'

Write-Host "`n=== FERTIG ===" -ForegroundColor Green
Write-Host "Melde dich zurueck, wenn du das gesehen hast!" -ForegroundColor Green
