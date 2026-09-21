<#
.SYNOPSIS
  Copies Hearth's nightly database backups from the server to this PC.

.DESCRIPTION
  Downloads any backup files that aren't here yet into the "backups" folder next to this script
  and keeps the newest 30. Run it by hand, or once with -Schedule to have Windows run it every day.
  Scheduled runs need SSH key sign-in (see README → Deploying updates from Windows).

.EXAMPLE
  .\pull-backups.cmd
.EXAMPLE
  .\pull-backups.cmd -Schedule
.EXAMPLE
  .\pull-backups.cmd -Unschedule
#>
param(
  [string]$Server = '',
  [string]$RemoteDir = '~/hearth',
  [string]$Destination = (Join-Path $PSScriptRoot 'backups'),
  [int]$Keep = 30,
  [switch]$Schedule,
  [switch]$Unschedule
)

$ErrorActionPreference = 'Stop'
$taskName = 'Hearth backup copy'

if ($Unschedule) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the daily '$taskName' task." -ForegroundColor Green
  return
}

# The server address lives in deploy.server (not committed to git). -Server sets and remembers it.
$serverFile = Join-Path $PSScriptRoot 'deploy.server'
if (-not $Server -and (Test-Path $serverFile)) { $Server = (Get-Content $serverFile -Raw).Trim() }
if (-not $Server) { throw 'Which server? Run once with -Server root@YOUR-SERVER-IP; it is remembered in deploy.server.' }
Set-Content -Path $serverFile -Value $Server -NoNewline -Encoding ascii

if ($Schedule) {
  $script = Join-Path $PSScriptRoot 'pull-backups.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Server $Server -RemoteDir $RemoteDir"
  $trigger = New-ScheduledTaskTrigger -Daily -At '5:00 AM'
  # Runs when the PC next wakes up if it was off or asleep at 5 AM.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Copies Hearth database backups from the server.' -Force | Out-Null
  Write-Host "Scheduled '$taskName' to run daily at 5:00 AM (or when the PC is next on)." -ForegroundColor Green
  Write-Host 'This needs SSH key sign-in so it can run without a password prompt.'
  return
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null

$listing = & ssh -o BatchMode=no $Server "ls -1 $RemoteDir/backups/ 2>/dev/null | grep -E '^hearth-.*\.sql\.gz$' || true"
if ($LASTEXITCODE -ne 0) { throw "Couldn't list backups on $Server (exit $LASTEXITCODE)." }
$remote = @($listing | Where-Object { $_ -match '^hearth-.*\.sql\.gz$' })
if (-not $remote.Count) {
  Write-Host 'No backups on the server yet.'
  return
}

$missing = @($remote | Where-Object { -not (Test-Path (Join-Path $Destination $_)) })
foreach ($name in $missing) {
  Write-Host "Downloading $name"
  & scp -q "${Server}:$RemoteDir/backups/$name" (Join-Path $Destination $name)
  if ($LASTEXITCODE -ne 0) { throw "Download of $name failed (exit $LASTEXITCODE)." }
}

# Keep only the newest $Keep backups here.
$old = Get-ChildItem -Path $Destination -Filter 'hearth-*.sql.gz' | Sort-Object Name -Descending | Select-Object -Skip $Keep
foreach ($file in $old) { Remove-Item $file.FullName -Force }

$count = (Get-ChildItem -Path $Destination -Filter 'hearth-*.sql.gz').Count
Write-Host "Backups on this PC: $count (in $Destination). Downloaded $($missing.Count) new." -ForegroundColor Green
