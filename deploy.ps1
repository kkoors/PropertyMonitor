$server = "root@104.248.232.119"
$remote = "/opt/water-bills"
$local = $PSScriptRoot

Write-Host "Building frontend..." -ForegroundColor Cyan
Push-Location $local
npm run build
Pop-Location

Write-Host "Copying files to server..." -ForegroundColor Cyan
scp -r "$local\dist"      "${server}:${remote}/"
scp -r "$local\server"    "${server}:${remote}/"
scp    "$local\package.json" "${server}:${remote}/"

Write-Host "Restarting PM2..." -ForegroundColor Cyan
ssh $server "cd $remote && npm install --omit=dev && pm2 restart water-bills"

Write-Host "Done." -ForegroundColor Green
