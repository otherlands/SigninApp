# signin-check.ps1 - eRIGHT Sign-In desktop reminder (v4.1).
#
# Runs when the user logs on to Windows and when they unlock the PC. If the PC is on the office network and the
# sign-in server answers, it checks whether THIS person is signed in. If they are not, it asks:
#     Yes    = sign me in now            (recorded as source "desktop", device = this PC's name)
#     No     = I am not in the office today   (no more reminders until tomorrow)
#     Cancel = not now                   (asks again at the next logon/unlock)
# It NEVER signs anyone in or out by itself, and never signs anyone out at all: a person who forgets to answer stays
# as they were (the register can only over-count, never under-count, because of this PC).
#
# Windows PowerShell 5.1 (built into Windows 10/11); no install, no admin rights needed.
#   Set up (once, on the PC, in the office):   powershell -ExecutionPolicy Bypass -File signin-check.ps1 -Setup
#   Remove:                                     powershell -ExecutionPolicy Bypass -File signin-check.ps1 -Uninstall
#   Diagnose (no window, prints the state):     powershell -ExecutionPolicy Bypass -File signin-check.ps1 -Check
# Settings: %APPDATA%\eRIGHT\signin-check.json   Log: %LOCALAPPDATA%\eRIGHT\signin-check.log
[CmdletBinding()]
param(
    [switch]$Setup,
    [switch]$Uninstall,
    [switch]$Check,
    [switch]$ConfigOnly,          # -Setup without registering the log-on task (tests, or a shared PC)
    [string]$Server = 'http://192.168.101.102:3000',
    [string[]]$OfficeSubnets,
    [string]$PersonId,
    [ValidateSet('', 'Yes', 'No', 'Cancel')][string]$Answer = '',   # tests: answer the prompt without a window
    [string]$ConfigPath = (Join-Path $env:APPDATA 'eRIGHT\signin-check.json'),
    [int]$WaitForNetworkSeconds = 60
)
$ErrorActionPreference = 'Stop'
$TaskName = 'eRIGHT Sign-In reminder'
$InstallDir = Join-Path $env:LOCALAPPDATA 'eRIGHT'
$LogFile = Join-Path $InstallDir 'signin-check.log'

function Write-Log([string]$msg) {
    try {
        if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force $InstallDir | Out-Null }
        if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 200KB) { Remove-Item $LogFile -Force }
        Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format s), $msg)
    } catch { }
    if ($Check -or $Answer) { Write-Host $msg }   # Write-Host, not Write-Output: output would become the caller's return value
}

# ---- network ------------------------------------------------------------------------------------------------
function ConvertTo-UInt32([string]$ip) {
    $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes()
    return ([uint32]$b[0] -shl 24) + ([uint32]$b[1] -shl 16) + ([uint32]$b[2] -shl 8) + [uint32]$b[3]
}
function Test-InSubnet([string]$ip, [string]$cidr) {
    $parts = $cidr.Split('/'); $bits = [int]$parts[1]
    if ($bits -eq 0) { return $true }
    $mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $bits))
    return ((ConvertTo-UInt32 $ip) -band $mask) -eq ((ConvertTo-UInt32 $parts[0]) -band $mask)
}
function Get-LocalIPv4 {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } |
        ForEach-Object { [pscustomobject]@{ Ip = $_.IPAddress; Prefix = $_.PrefixLength; Alias = $_.InterfaceAlias } }
}
function Get-SubnetOf($addr) {
    $mask = [uint32]([math]::Pow(2, 32) - [math]::Pow(2, 32 - $addr.Prefix))
    $n = (ConvertTo-UInt32 $addr.Ip) -band $mask
    return ('{0}.{1}.{2}.{3}/{4}' -f (($n -shr 24) -band 255), (($n -shr 16) -band 255), (($n -shr 8) -band 255), ($n -band 255), $addr.Prefix)
}
function Test-OnOfficeNetwork($subnets) {
    foreach ($a in Get-LocalIPv4) { foreach ($s in $subnets) { if (Test-InSubnet $a.Ip $s) { return $a.Ip } } }
    return $null
}

# ---- server -------------------------------------------------------------------------------------------------
function Get-State([string]$server) {
    return Invoke-RestMethod -Uri ($server.TrimEnd('/') + '/api/state') -TimeoutSec 8 -UseBasicParsing
}
function Invoke-SignIn([string]$server, [string]$personId) {
    $body = @{ personId = $personId; direction = 'in'; source = 'desktop'; note = "confirmed on PC $env:COMPUTERNAME" } | ConvertTo-Json
    return Invoke-RestMethod -Uri ($server.TrimEnd('/') + '/api/sign') -Method Post -Body $body -ContentType 'application/json' `
        -Headers @{ 'X-Device' = ("pc-" + $env:COMPUTERNAME).ToLower() } -TimeoutSec 8 -UseBasicParsing
}

# ---- settings -------------------------------------------------------------------------------------------------
function Read-Config {
    if (-not (Test-Path $ConfigPath)) { return $null }
    return Get-Content $ConfigPath -Raw | ConvertFrom-Json
}
function Save-Config($cfg) {
    $dir = Split-Path $ConfigPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    $cfg | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding UTF8
}

# ---- windows ------------------------------------------------------------------------------------------------
function Show-Box([string]$text, [string]$buttons = 'OK', [string]$icon = 'Information') {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.WindowState = 'Minimized'
    try { return [System.Windows.Forms.MessageBox]::Show($owner, $text, 'eRIGHT Sign-In', $buttons, $icon).ToString() }
    finally { $owner.Dispose() }
}
function Select-Person($people) {
    Add-Type -AssemblyName System.Windows.Forms
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'eRIGHT Sign-In - who uses this PC?'; $form.Width = 380; $form.Height = 420; $form.StartPosition = 'CenterScreen'; $form.TopMost = $true
    $label = New-Object System.Windows.Forms.Label; $label.Text = 'Choose your name:'; $label.Left = 12; $label.Top = 10; $label.Width = 340
    $list = New-Object System.Windows.Forms.ListBox; $list.Left = 12; $list.Top = 34; $list.Width = 340; $list.Height = 290
    foreach ($p in $people) { [void]$list.Items.Add($p.name) }
    $ok = New-Object System.Windows.Forms.Button; $ok.Text = 'OK'; $ok.Left = 196; $ok.Top = 334; $ok.DialogResult = 'OK'
    $cancel = New-Object System.Windows.Forms.Button; $cancel.Text = 'Cancel'; $cancel.Left = 277; $cancel.Top = 334; $cancel.DialogResult = 'Cancel'
    $form.Controls.AddRange(@($label, $list, $ok, $cancel)); $form.AcceptButton = $ok; $form.CancelButton = $cancel
    if ($form.ShowDialog() -ne 'OK' -or $list.SelectedIndex -lt 0) { return $null }
    return $people[$list.SelectedIndex]
}

# ---- setup / uninstall ----------------------------------------------------------------------------------------
function Install-Reminder {
    $state = $null
    try { $state = Get-State $Server } catch { throw "Cannot reach the sign-in server at $Server ($($_.Exception.Message)). Run setup in the office, on the office network." }
    $people = @($state.people | Sort-Object name)
    $person = $null
    if ($PersonId) { $person = $people | Where-Object { $_.id -eq $PersonId } | Select-Object -First 1 }
    else { $person = Select-Person $people }
    if (-not $person) { throw 'No person chosen: nothing set up.' }
    # The office network = the one this PC is on now (setup is done in the office), unless given.
    $subnets = $OfficeSubnets
    if (-not $subnets) {
        $hostPart = ([uri]$Server).Host
        $route = $null
        try { $route = Find-NetRoute -RemoteIPAddress $hostPart -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1 } catch { }
        $addr = Get-LocalIPv4 | Where-Object { $route -and $_.Ip -eq $route.IPAddress } | Select-Object -First 1
        if (-not $addr) { throw 'Could not tell which network this PC is on; give -OfficeSubnets 192.168.x.0/24.' }
        $subnets = @(Get-SubnetOf $addr)
    }
    $cfg = [pscustomobject]@{ server = $Server; personId = $person.id; personName = $person.name; officeSubnets = @($subnets); snoozedDay = '' }
    Save-Config $cfg
    if (-not (Test-Path $InstallDir)) { New-Item -ItemType Directory -Force $InstallDir | Out-Null }
    $target = Join-Path $InstallDir 'signin-check.ps1'
    if (-not $ConfigOnly -and $PSCommandPath -ne $target) { Copy-Item $PSCommandPath $target -Force }
    $arg = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$target`""
    $how = ''
    if ($ConfigOnly) { $how = 'settings only (no log-on task)' }
    else { try {
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
        $user = "$env:USERDOMAIN\$env:USERNAME"
        $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
        $cls = Get-CimClass -Namespace ROOT\Microsoft\Windows\TaskScheduler -ClassName MSFT_TaskSessionStateChangeTrigger
        $unlock = New-CimInstance -CimClass $cls -ClientOnly -Property @{ StateChange = 8; UserId = $user; Enabled = $true }   # 8 = session unlock
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
        $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $unlock) -Settings $settings -Principal $principal -Force | Out-Null
        $how = "a scheduled task '$TaskName' (at log on and at unlock)"
    } catch {
        # Fallback that never needs admin rights: the user's Startup folder (log on only).
        $startup = [Environment]::GetFolderPath('Startup')
        Set-Content -Path (Join-Path $startup 'eRIGHT Sign-In reminder.cmd') -Value "@start """" /min powershell.exe $arg" -Encoding ASCII
        $how = "the Startup folder (at log on only; the scheduled task was refused: $($_.Exception.Message))"
    } }
    Write-Log "set up for $($person.name) ($($person.id)) server $Server office $($subnets -join ',') via $how"
    $msg = "Set up for $($person.name).`n`nThis PC will check at log on (and unlock) whether you are signed in when it is on the office network ($($subnets -join ', ')), and ask if you are not.`n`nInstalled as $how."
    if ($Answer) { Write-Output $msg } else { [void](Show-Box $msg) }
}
function Uninstall-Reminder {
    try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop } catch { }
    Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'eRIGHT Sign-In reminder.cmd') -Force -ErrorAction SilentlyContinue
    Remove-Item $ConfigPath -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $InstallDir 'signin-check.ps1') -Force -ErrorAction SilentlyContinue
    Write-Log 'removed'
    Write-Output 'eRIGHT Sign-In reminder removed.'
}

# ---- the check --------------------------------------------------------------------------------------------------
function Invoke-Reminder {
    $cfg = Read-Config
    if (-not $cfg) { Write-Log 'not set up (run with -Setup)'; return 3 }
    $today = Get-Date -Format 'yyyy-MM-dd'
    # At log on the network can take a while: retry until the office network and the server are both there.
    $deadline = (Get-Date).AddSeconds($WaitForNetworkSeconds)
    $ip = $null; $state = $null; $lastError = ''
    while ($true) {
        $ip = Test-OnOfficeNetwork @($cfg.officeSubnets)
        if ($ip) { try { $state = Get-State $cfg.server; break } catch { $lastError = $_.Exception.Message } } else { $lastError = 'not on the office network' }
        if ((Get-Date) -ge $deadline) { break }
        Start-Sleep -Seconds 5
    }
    if (-not $ip) { Write-Log "skip: not on the office network ($($cfg.officeSubnets -join ','))"; return 0 }
    if (-not $state) { Write-Log "skip: server $($cfg.server) not reachable from $ip ($lastError)"; return 0 }
    $me = @($state.people) | Where-Object { $_.id -eq $cfg.personId } | Select-Object -First 1
    if (-not $me) {
        Write-Log "person $($cfg.personName) ($($cfg.personId)) is not on the staff list any more"
        if (-not $Check -and -not $Answer) { [void](Show-Box "$($cfg.personName) is not on the eRIGHT staff list any more. Ask the admin, then run the setup again." 'OK' 'Warning') }
        return 4
    }
    if ($me.signedIn) { Write-Log "ok: $($me.name) is signed in (on $ip)"; return 0 }
    if ($cfg.snoozedDay -eq $today) { Write-Log "skip: $($me.name) said not in the office today"; return 0 }
    if ($Check) { Write-Log "NOT SIGNED IN: $($me.name) (on $ip); a reminder would be shown"; return 1 }
    $rc = ''
    if ($state.rollcall) { $rc = "`n`nA fire roll call is running: signing in now does NOT add you to it - tell whoever is running it." }
    $text = "Hi $($me.name) - you are not signed in at $($state.companyName).$rc`n`nSign in now?`n`nYes = sign me in`nNo = I am not in the office today (no more reminders today)`nCancel = not now"
    $choice = $Answer
    if (-not $choice) { $choice = Show-Box $text 'YesNoCancel' 'Question' }
    if ($choice -eq 'Yes') {
        try {
            $r = Invoke-SignIn $cfg.server $cfg.personId
            Write-Log "signed in: $($me.name) at $($r.event.at) (from $ip)"
            if (-not $Answer) { [void](Show-Box "Signed in, $($me.name). Remember to sign out at the kiosk or with your card when you leave.") }
            return 0
        } catch {
            Write-Log "sign-in FAILED for $($me.name): $($_.Exception.Message)"
            if (-not $Answer) { [void](Show-Box "Could not sign you in: $($_.Exception.Message)`n`nPlease sign in at the kiosk or with your card." 'OK' 'Error') }
            return 2
        }
    }
    if ($choice -eq 'No') {
        $cfg.snoozedDay = $today; Save-Config $cfg
        Write-Log "$($me.name) said not in the office today"
        return 0
    }
    Write-Log "$($me.name) chose not now"
    return 0
}

try {
    if ($Uninstall) { Uninstall-Reminder; exit 0 }
    if ($Setup) { Install-Reminder; exit 0 }
    exit (Invoke-Reminder)
} catch {
    Write-Log "error: $($_.Exception.Message)"
    if (-not $Check -and -not $Answer -and $Setup) { [void](Show-Box $_.Exception.Message 'OK' 'Error') }
    Write-Error $_.Exception.Message
    exit 9
}
