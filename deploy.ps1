<#
.SYNOPSIS
  Deploys Hearth to the server: database backup, copy files, rebuild, health check,
  then copies new nightly backups to this PC.

.EXAMPLE
  .\deploy.cmd -Server root@YOUR-SERVER-IP    (first time; remembered in deploy.server)
.EXAMPLE
  .\deploy.cmd
.EXAMPLE
  .\deploy.cmd -SkipBackup
.EXAMPLE
  .\deploy.cmd -ComposeProfile https
#>
param(
  [string]$Server = '',
  [string]$RemoteDir = '~/hearth',
  [string]$ComposeProfile = 'tunnel',
  [switch]$SkipBackup
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# The server address lives in deploy.server (not committed to git). -Server sets and remembers it.
$serverFile = Join-Path $PSScriptRoot 'deploy.server'
if (-not $Server -and (Test-Path $serverFile)) { $Server = (Get-Content $serverFile -Raw).Trim() }
if (-not $Server) { throw 'Which server? Run once with -Server root@YOUR-SERVER-IP; it is remembered in deploy.server.' }
Set-Content -Path $serverFile -Value $Server -NoNewline -Encoding ascii

function Step([string]$message) {
  Write-Host ''
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Invoke-Native([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$exe failed with exit code $LASTEXITCODE" }
}

# --- What is being deployed --------------------------------------------------------
$commit = 'uncommitted'
if (Get-Command git -ErrorAction SilentlyContinue) {
  $head = git -C $root rev-parse --short HEAD 2>$null
  if ($LASTEXITCODE -eq 0 -and $head) { $commit = $head }
  $dirty = git -C $root status --porcelain 2>$null
  if ($dirty) {
    Write-Warning 'Some changes are not committed to git yet. They will be deployed anyway.'
    $commit = "$commit+changes"
  }
}
Write-Host "Deploying Hearth ($commit) to $Server" -ForegroundColor Green

# --- Package -------------------------------------------------------------------------
Step 'Packing files'
$archive = Join-Path $env:TEMP 'hearth-deploy.tar.gz'
if (Test-Path $archive) { Remove-Item $archive -Force }
Invoke-Native 'tar' @('-czf', $archive, '--exclude=node_modules', '--exclude=.git', '--exclude=backups', '--exclude=.env', '--exclude=deploy.server', '--exclude=.github', '-C', $root, '.')
'{0:N0} KB' -f ((Get-Item $archive).Length / 1KB) | Write-Host

# --- Copy ----------------------------------------------------------------------------
Step 'Copying to the server'
Invoke-Native 'scp' @($archive, "${Server}:~/hearth-deploy.tar.gz")

# --- Backup, unpack, rebuild, health check (one SSH session) ---------------------------
Step 'Updating the server'
if ($SkipBackup) {
  $backup = 'echo Skipping database backup'
} else {
  # Keep the five most recent pre-deploy backups.
  $backup = 'mkdir -p ~/hearth-deploy-backups && docker compose exec -T db pg_dump -U hearth hearth | gzip > ~/hearth-deploy-backups/before-$(date +%Y%m%d-%H%M%S).sql.gz && echo Database backed up to ~/hearth-deploy-backups && ls -1t ~/hearth-deploy-backups/*.sql.gz | tail -n +6 | xargs -r rm --'
}
$steps = @(
  'set -eo pipefail',
  'cd {DIR}',
  $backup,
  'tar -xzf ~/hearth-deploy.tar.gz -C {DIR}',
  'rm -f ~/hearth-deploy.tar.gz',
  'echo {COMMIT} > DEPLOYED',
  'echo {COMMIT} > app/VERSION',
  'mkdir -p backups',
  # Build from the copied source rather than pulling the published image.
  'docker compose -f docker-compose.yml -f docker-compose.build.yml --profile {PROFILE} up -d --build',
  'echo Waiting for Hearth to start...',
  'ok=0; for i in $(seq 1 45); do if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok=1; break; fi; sleep 2; done',
  'docker compose --profile {PROFILE} ps',
  'docker compose logs --tail 12 app',
  'if [ $ok = 1 ]; then echo HEARTH_OK; else echo HEARTH_NOT_HEALTHY; exit 3; fi'
)
$remote = ($steps -join '; ').Replace('{DIR}', $RemoteDir).Replace('{PROFILE}', $ComposeProfile).Replace('{COMMIT}', $commit)
& ssh $Server $remote
$code = $LASTEXITCODE
Remove-Item $archive -Force -ErrorAction SilentlyContinue

if ($code -eq 0) {
  Write-Host ''
  Write-Host "Deployed $commit. Hearth is up." -ForegroundColor Green
  # Keep a copy of the nightly backups on this PC too.
  Step 'Copying new backups to this PC'
  try {
    & (Join-Path $root 'pull-backups.ps1') -Server $Server -RemoteDir $RemoteDir
  } catch {
    Write-Warning "Couldn't copy backups: $($_.Exception.Message)"
  }
} elseif ($code -eq 3) {
  Write-Host ''
  Write-Host 'The update was installed but Hearth did not report healthy within 90 seconds.' -ForegroundColor Yellow
  Write-Host "Check the logs:  ssh $Server 'cd $RemoteDir && docker compose logs --tail 50 app'"
  exit 3
} else {
  throw "Deploy failed on the server (exit code $code). Nothing after the failing step was run."
}
