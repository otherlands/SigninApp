# Build the eRIGHT Door APK with the Android SDK alone: aapt2 + javac + d8 + zipalign + apksigner. No Gradle, no
# downloads. The signing key is The Vault's item android:eright-door-signing (password; the keystore file is
# attached to the same item and kept at $Keystore). Run through the vault so the password is never typed or printed:
#   python D:\MANORVIEW\switchyard-platform\tools\vault.py run android:eright-door-signing -- powershell -File android\build.ps1
# Output: android\build\eright-door-<version>.apk and a copy at public\eright-door.apk (served at /eright-door.apk).
param(
    [string]$Keystore = 'D:\eRIGHT\keys\eright-door.jks',
    [switch]$NoPublish
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
$bt = "$sdk\build-tools\36.1.0"
$platform = "$sdk\platforms\android-35\android.jar"
$jdk = 'C:\Program Files\Android\Android Studio\jbr\bin'
foreach ($p in @("$bt\aapt2.exe", "$bt\d8.bat", "$bt\zipalign.exe", "$bt\apksigner.bat", $platform, "$jdk\javac.exe")) { if (-not (Test-Path $p)) { throw "missing: $p" } }
if (-not $env:VAULT_PASS) { throw 'Run me through the vault: vault.py run android:eright-door-signing -- powershell -File android\build.ps1' }
if (-not (Test-Path $Keystore)) { throw "keystore not found at $Keystore (it is attached to android:eright-door-signing in The Vault)" }
$env:JAVA_HOME = Split-Path $jdk

$version = (Get-Content "$here\version.txt" -Raw).Trim()
if ($version -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "version.txt must be MAJOR.MINOR.PATCH, got '$version'" }
$code = [int]$Matches[1] * 10000 + [int]$Matches[2] * 100 + [int]$Matches[3]

$out = "$here\build"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\gen", "$out\classes", "$out\dex" | Out-Null

function Run($exe, [string[]]$argv) {
    & $exe @argv
    if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed ($LASTEXITCODE)" }
}

Write-Host "== resources"
Run "$bt\aapt2.exe" @('compile', '--dir', "$here\res", '-o', "$out\res.zip")
Run "$bt\aapt2.exe" @('link', '-o', "$out\base.apk", '-I', $platform, '--manifest', "$here\AndroidManifest.xml", '--java', "$out\gen",
    '--min-sdk-version', '29', '--target-sdk-version', '34', '--version-code', "$code", '--version-name', $version, "$out\res.zip")

Write-Host "== java"
$sources = @(Get-ChildItem -Recurse "$here\src", "$out\gen" -Filter *.java | ForEach-Object FullName)
Run "$jdk\javac.exe" (@('--release', '8', '-classpath', $platform, '-encoding', 'UTF-8', '-Xlint:-options', '-d', "$out\classes") + $sources)

Write-Host "== dex"
$classes = @(Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName)
Run "$bt\d8.bat" (@('--release', '--min-api', '29', '--lib', $platform, '--output', "$out\dex") + $classes)

Write-Host "== package + sign"
Copy-Item "$out\base.apk" "$out\unsigned.apk"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open("$out\unsigned.apk", 'Update')
[void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$out\dex\classes.dex", 'classes.dex')
$zip.Dispose()
Run "$bt\zipalign.exe" @('-f', '-p', '4', "$out\unsigned.apk", "$out\aligned.apk")
$apk = "$out\eright-door-$version.apk"
Run "$bt\apksigner.bat" @('sign', '--ks', $Keystore, '--ks-key-alias', 'eright-door', '--ks-pass', 'env:VAULT_PASS', '--key-pass', 'env:VAULT_PASS', '--out', $apk, "$out\aligned.apk")
Run "$bt\apksigner.bat" @('verify', '--print-certs', $apk)

if (-not $NoPublish) { Copy-Item $apk "$here\..\public\eright-door.apk" -Force; Write-Host "published: public\eright-door.apk" }
$sha = -join ([System.Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes($apk)) | ForEach-Object { $_.ToString('x2') })
Write-Host ("built {0} ({1:N0} bytes) version {2} ({3}) sha256 {4}" -f $apk, (Get-Item $apk).Length, $version, $code, $sha)
