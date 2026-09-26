# Minecraft network setup for Windows. The Worker serves this at /s/<code> with the three
# values below filled in; people run it as:  irm <worker>/s/<code> | iex
# It runs inside the person's own PowerShell window, so it never calls `exit` (that would
# close their window): everything is in one script block that returns or throws instead.
& {
$WorkerUrl = '__WORKER_URL__'
$Code = '__CODE__'
$Mode = '__MODE__'

$Repo = 'alexvtejeda/minecraft-discord-bot'
$PlayerTag = 'tag:mc-player'
$FirewallName = 'Minecraft (mc-host)'
$TsExe = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$TsMsi = 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is far slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($text) { Write-Host $text }

# POST JSON to the Worker; on failure, throw the Worker's own plain-English message.
function Api($path, $body) {
  try {
    return Invoke-RestMethod -Method Post -Uri "$WorkerUrl$path" -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress)
  } catch {
    $msg = $null
    try { $msg = ($_.ErrorDetails.Message | ConvertFrom-Json).message } catch {}
    if (-not $msg) { $msg = "Couldn't reach the Minecraft bot ($($_.Exception.Message)). Check your internet connection and run the line again." }
    throw $msg
  }
}

# Windows PowerShell 5.1 turns a native command's redirected stderr into a terminating error
# under 'Stop', so every tailscale.exe call runs with 'Continue'.
function TsStatus {
  $ErrorActionPreference = 'Continue'
  if (-not (Test-Path $TsExe)) { return $null }
  try { return (& $TsExe status --json 2>$null | Out-String | ConvertFrom-Json) } catch { return $null }
}

function OnMinecraftNetwork($st) {
  return [bool]($st -and $st.Self -and $st.Self.Tags -and (@($st.Self.Tags) -contains $PlayerTag))
}

function Main {
  $isHost = $Mode -eq 'host'

  # 1. Preflight
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ([Environment]::OSVersion.Version.Major -lt 10 -or $arch -ne 'AMD64') {
    throw 'This installer needs 64-bit Windows 10 or 11 on an Intel or AMD processor. Ask a maintainer for help.'
  }
  if ($isHost -and (Get-Process mc-host -ErrorAction SilentlyContinue)) {
    throw 'mc-host is running. Stop hosting first (Ctrl+C in its window), then run the line again.'
  }
  $st = TsStatus
  $joined = OnMinecraftNetwork $st
  if ($st -and -not $joined -and @('Running', 'Starting', 'Stopped') -contains $st.BackendState) {
    throw "Tailscale on this PC is signed in to another network. This installer won't change it. Ask a maintainer for help."
  }

  # 2. Admin step: one permission prompt for everything that needs it
  $needTailscale = -not (Test-Path $TsExe)
  $needFirewall = $isHost -and -not (Get-NetFirewallRule -DisplayName "$FirewallName*" -ErrorAction SilentlyContinue)
  if ($needTailscale -or $needFirewall) {
    $msi = ''
    if ($needTailscale) {
      Say 'Downloading Tailscale...'
      $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
      Invoke-WebRequest -UseBasicParsing -Uri $TsMsi -OutFile $msi
    }
    $msiQ = $msi -replace "'", "''"
    $fwQ = $FirewallName -replace "'", "''"
    $admin = @"
`$ErrorActionPreference = 'Stop'
if ('$msiQ' -ne '') {
  `$p = Start-Process msiexec.exe -ArgumentList '/i "$msiQ" /quiet /norestart' -Wait -PassThru
  if (`$p.ExitCode -ne 0 -and `$p.ExitCode -ne 3010) { exit 10 }
}
if ('$needFirewall' -eq 'True') {
  Get-NetFirewallRule -DisplayName '$fwQ*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName '$fwQ (game)' -Direction Inbound -Protocol TCP -LocalPort 25565 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
  New-NetFirewallRule -DisplayName '$fwQ (voice chat)' -Direction Inbound -Protocol UDP -LocalPort 24454 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
}
exit 0
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($admin))
    Say 'Windows will ask for permission next. Click Yes.'
    try {
      $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
    } catch {
      throw 'Setup needs you to click Yes on the permission prompt. Run the line again to retry.'
    }
    if ($p.ExitCode -eq 10) { throw "Tailscale didn't install. Restart your PC and run the line again. If it still fails, tell a maintainer." }
    if ($p.ExitCode -ne 0) { throw "The admin step failed (code $($p.ExitCode)). Tell a maintainer." }
    if ($needTailscale) {
      Say 'Waiting for Tailscale to start...'
      for ($i = 0; $i -lt 30 -and -not (TsStatus); $i++) { Start-Sleep -Seconds 1 }
      if (-not (TsStatus)) { throw "Tailscale installed but didn't start. Restart your PC and run the line again." }
    }
  }

  # 3. Redeem (after the install, so the 10-minute network key doesn't expire while it runs)
  Say 'Getting your network key...'
  $r = Api '/enroll' @{ code = $Code; join = (-not $joined) }

  # 4. Join
  if (-not $joined) {
    Say 'Joining the Minecraft network...'
    & { $ErrorActionPreference = 'Continue'; & $TsExe up "--auth-key=$($r.authKey)" "--hostname=$($r.hostname)" | Out-Host }
    $ip = $null
    for ($i = 0; $i -lt 60 -and -not $ip; $i++) {
      $st = TsStatus
      if ($st -and $st.BackendState -eq 'Running' -and $st.Self.TailscaleIPs) { $ip = @($st.Self.TailscaleIPs)[0] } else { Start-Sleep -Seconds 1 }
    }
    if (-not $ip) {
      $status = & { $ErrorActionPreference = 'Continue'; & $TsExe status 2>&1 | Out-String }
      throw "Tailscale didn't connect. Paste the text below into Discord for a maintainer.`n$status"
    }
  }

  # 5. Report this device, so a maintainer can remove it later
  $st = TsStatus
  Api '/enroll/device' @{ code = $Code; nodeId = $st.Self.ID } | Out-Null

  # 6. Hosting
  if ($isHost) {
    $bin = Join-Path $env:LOCALAPPDATA 'mc-host\bin'
    New-Item -ItemType Directory -Force -Path $bin | Out-Null
    $exe = Join-Path $bin 'mc-host.exe'
    $base = "https://github.com/$Repo/releases/latest/download"
    Say 'Downloading mc-host...'
    $tmp = "$exe.download"
    $sums = "$exe.sums"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/mc-host-windows-x64.exe" -OutFile $tmp
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    $line = Get-Content $sums | Where-Object { $_ -match '[\s*]mc-host-windows-x64\.exe$' } | Select-Object -First 1
    Remove-Item $sums
    $want = if ($line) { ($line -split '\s+')[0].ToLower() } else { '' }
    $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    if (-not $want -or $got -ne $want) {
      Remove-Item $tmp
      throw "The mc-host download didn't match its checksum. Run /setup host again in a few minutes."
    }
    Move-Item -Force $tmp $exe

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $bin)) {
      [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $bin) | Where-Object { $_ }) -join ';'), 'User')
    }
    $env:Path = "$env:Path;$bin"

    # UTF-8 without a BOM: Set-Content -Encoding UTF8 would add one.
    $cfgDir = Join-Path $env:APPDATA 'mc-host'
    New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
    $json = @{ workerUrl = $WorkerUrl; token = $r.token } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText((Join-Path $cfgDir 'agent.json'), $json, (New-Object Text.UTF8Encoding $false))

    $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Host Minecraft.lnk'
    $sc = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $sc.Arguments = "/k title Minecraft host - press Ctrl+C to save and stop. Don't close this window. & `"$exe`" start"
    $sc.WorkingDirectory = $bin
    $sc.Description = 'Host the Minecraft world'
    $sc.Save()

    Say ''
    & $exe status | Out-Host
  }

  # 7. Done
  Say ''
  Write-Host "You're on the Minecraft network. Run /join in Discord for the address." -ForegroundColor Green
  if ($isHost) {
    Write-Host 'To host, open Host Minecraft from the Start Menu. Press Ctrl+C in that window to save and stop.' -ForegroundColor Green
  }
  if ($joined -and $st.BackendState -ne 'Running') {
    Write-Host 'Tailscale is installed but not connected. Open Tailscale from the Start Menu and click Connect.' -ForegroundColor Yellow
  }
}

try { Main } catch { Write-Host ''; Write-Host $_.Exception.Message -ForegroundColor Red }
}
