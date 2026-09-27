# demo-presence.ps1 — throwaway local server on :3199 with a tagged person walking back-door -> anchor.
# Proves the presence engine end to end on this PC; deletes its data folder when done. Never point at the live server.
$ErrorActionPreference = 'Stop'
Set-Location "$PSScriptRoot\.."
if (Test-Path data) { Remove-Item -Recurse -Force data }
$env:PORT = '3199'; $env:ADMIN_PIN = '1234'; $env:API_TOKEN = 'tok'
$p = Start-Process -FilePath node -ArgumentList '--disable-warning=ExperimentalWarning', 'server.js' -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru
Remove-Item Env:PORT, Env:ADMIN_PIN, Env:API_TOKEN
Start-Sleep 1.5
try {
    $H = @{ 'Content-Type' = 'application/json'; 'X-Admin-Pin' = '1234' }
    $S = @{ 'Content-Type' = 'application/json'; 'X-Api-Token' = 'tok' }
    $B = 'http://127.0.0.1:3199'
    foreach ($n in 'Alan Meade', 'Toby Gladman') { Invoke-RestMethod -Method Post "$B/api/people" -Headers $H -Body (@{ name = $n } | ConvertTo-Json) | Out-Null }
    $ppl = Invoke-RestMethod "$B/api/people" -Headers $H
    Invoke-RestMethod -Method Patch "$B/api/people/$($ppl[0].id)" -Headers $H -Body (@{ tagId = 'ibeacon:E2C5-DEMO:1:7' } | ConvertTo-Json) | Out-Null
    # back door hears Alan's tag + an unknown tag; then the anchor hears Alan's tag => walked in
    Invoke-RestMethod -Method Post "$B/api/presence/ble" -Headers $S -Body (@{ scanner = 'back-door'; sightings = @(@{ tag = 'ibeacon:E2C5-DEMO:1:7'; rssi = -58 }, @{ tag = 'mac:C0:FF:EE:00:00:01'; rssi = -71 }) } | ConvertTo-Json -Depth 4) | Out-Null
    Invoke-RestMethod -Method Post "$B/api/presence/ble" -Headers $S -Body (@{ scanner = 'anchor'; sightings = @(@{ tag = 'ibeacon:E2C5-DEMO:1:7'; rssi = -66 }) } | ConvertTo-Json -Depth 4) | Out-Null
    Write-Host "--- people ---"
    (Invoke-RestMethod "$B/api/state").people | Select-Object name, signedIn, lastSource, @{ n = 'presence'; e = { $_.presence.state } } | Format-Table -AutoSize
    Write-Host "--- last event ---"
    (Invoke-RestMethod "$B/api/events?limit=1" -Headers $H)[0] | Select-Object kind, source, device, note | Format-List
    Write-Host "--- presence panel ---"
    $pr = Invoke-RestMethod "$B/api/presence" -Headers $H
    "scanners: " + (($pr.health.scanners | ForEach-Object { "$($_.name) ${($_.ageS)}s" }) -join ', ')
    "unassigned tags for the picker: " + (($pr.candidates.tags | ForEach-Object { $_.ident }) -join ', ')
    "wifi brace: enabled=$($pr.health.wifi.enabled)"
    Write-Host "--- metrics ---"
    (Invoke-WebRequest "$B/metrics" -UseBasicParsing).Content -split "`n" | Where-Object { $_ -match '^signin_(presence_here|probably_left|scanner_last|tag_last)' }
}
finally {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep 1
    Remove-Item -Recurse -Force data -ErrorAction SilentlyContinue
    "data folder removed: $(-not (Test-Path data))"
}
