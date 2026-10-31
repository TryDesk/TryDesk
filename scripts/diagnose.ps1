# diagnose.ps1 - run this ON THE PC WHERE TryDesk WON'T START.
# It collects why, into a report on your Desktop that you can send back.
#
#   Right-click > Run with PowerShell   (or:)
#   powershell -ExecutionPolicy Bypass -File .\diagnose.ps1
#
# Optional: pass the exe path:  .\diagnose.ps1 -Exe "C:\path\TryDesk-Portable.exe"

param([string]$Exe)

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'trydesk-diagnostic.txt'
function W($t) { $t | Tee-Object -FilePath $out -Append }
"" | Out-File $out
W "==== TryDesk diagnostic - $(Get-Date) ===="

# 1) Find the exe
if (-not $Exe) {
  $cands = @("$env:USERPROFILE\Downloads","$env:USERPROFILE\Desktop","$env:LOCALAPPDATA\Programs\TryDesk","$env:ProgramFiles\TryDesk") |
    ForEach-Object { Get-ChildItem $_ -Filter "TryDesk*.exe" -ErrorAction SilentlyContinue }
  $Exe = ($cands | Select-Object -First 1).FullName
}
W "Exe: $Exe"
if (-not $Exe -or -not (Test-Path $Exe)) { W "!! TryDesk .exe not found - pass -Exe <path> and re-run."; return }

# 2) Windows / hardware
try { $os = Get-CimInstance Win32_OperatingSystem; W "OS : $($os.Caption) $($os.Version) $($os.OSArchitecture)" } catch {}
W "PSVersion: $($PSVersionTable.PSVersion)"

# 3) "Downloaded from internet" mark (SmartScreen trigger) + size
try {
  $z = Get-Content -Path $Exe -Stream Zone.Identifier -ErrorAction Stop
  W "Zone.Identifier present (file is marked downloaded-from-internet -> SmartScreen may block):"; W ($z -join "`n")
} catch { W "Zone.Identifier: none (not marked / already unblocked)" }
W "Size MB: $([math]::Round((Get-Item $Exe).Length/1MB,1))"

# 4) Windows Defender detections for TryDesk
try {
  $th = Get-MpThreatDetection -ErrorAction Stop | Where-Object { $_.Resources -match 'TryDesk' }
  if ($th) { W "!! Defender DETECTED/quarantined TryDesk:"; $th | ForEach-Object { W " - $($_.ThreatID) $($_.Resources)" } }
  else { W "Defender: no TryDesk detections" }
} catch { W "Defender query not available (maybe disabled / Sandbox)" }

# 5) Try launching with logging + no-gpu, then see if a window appeared
$chrome = Join-Path $env:TEMP 'trydesk-chrome.log'
Remove-Item $chrome -ErrorAction SilentlyContinue
W "`n-- launching with --no-gpu --enable-logging (8s) --"
try {
  $p = Start-Process $Exe -ArgumentList '--no-gpu','--enable-logging',"--log-file=$chrome",'--v=1' -PassThru
  Start-Sleep -Seconds 8
  if ($p.HasExited) { W "Process EXITED on its own, code $($p.ExitCode) (it crashed/quit at startup)" }
  else {
    $p.Refresh()
    W "Process alive. MainWindowHandle: $($p.MainWindowHandle) (0 = no visible window)"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  }
} catch { W "Launch failed: $($_.Exception.Message)" }

# 6) Our own startup log (tells how far the app's JS got)
$crash = Join-Path $env:APPDATA 'TryDesk\trydesk-crash.log'
W "`n-- app startup log ($crash) --"
if (Test-Path $crash) { W (Get-Content $crash -Tail 40 -Raw) } else { W "(none - the app's JS likely never ran: blocked before launch, e.g. Defender/SmartScreen or a missing system component)" }

# 7) Chromium log tail
W "`n-- chromium log tail --"
if (Test-Path $chrome) { W (Get-Content $chrome -Tail 40 -Raw) } else { W "(no chromium log written)" }

# 8) Windows Event Viewer app errors for TryDesk (last 30 min)
W "`n-- Event Viewer (Application Error/Hang, last 30 min) --"
try {
  Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-30); Id=1000,1002,1026} -ErrorAction Stop |
    Where-Object { $_.Message -match 'TryDesk' } | ForEach-Object { W ("[" + $_.TimeCreated + "] " + ($_.Message -split "`n")[0]) }
} catch { W "(no matching events / query unavailable)" }

W "`n==== done. Send this file: $out ===="
Start-Process notepad $out
