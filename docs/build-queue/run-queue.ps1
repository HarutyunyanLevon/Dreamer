# Dreamer build queue: runs each prompt in prompts\ as a fresh Claude Code session
# (claude -p = new context, same as /clear), commits after each, stops on failure.
#
#   .\run-queue.ps1                  # run all, safe-ish permissions
#   .\run-queue.ps1 -From 3          # resume at prompt 3
#   .\run-queue.ps1 -SkipPermissions # fully unattended (use on a branch)
#   .\run-queue.ps1 -WaitPid 1234    # wait for that process to exit first

param(
  [int]$From = 1,
  [switch]$SkipPermissions,
  [int]$WaitPid = 0
)

$ErrorActionPreference = 'Continue'
# UTF-8 so arrows/dashes in the prompts survive the pipe into claude
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$queue = Join-Path $PSScriptRoot 'prompts'
$logs  = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null

if ($WaitPid -gt 0) {
  Write-Host "Waiting for process $WaitPid to exit..." -ForegroundColor DarkGray
  Wait-Process -Id $WaitPid -ErrorAction SilentlyContinue
}

$models = @{ 1 = 'opus'; 2 = 'sonnet'; 3 = 'sonnet'; 4 = 'sonnet'; 5 = 'opus'; 6 = 'sonnet' }

$allowed = @(
  'Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', 'LS', 'TodoWrite',
  'Bash(cd:*)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(mkdir:*)', 'Bash(rg:*)', 'Bash(grep:*)',
  'Bash(cargo:*)', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(pnpm:*)', 'Bash(node:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git mv:*)', 'Bash(git rm:*)'
)

$suffix = @"


---
If git status shows uncommitted changes at the start, they are an interrupted earlier run of THIS prompt: review and continue them, do not restart or revert them.
You are running unattended in a queue. Nobody will answer questions: decide yourself, write each decision in one line to docs/decisions.md, and finish the whole prompt. If a command is denied, find another way or note it in docs/decisions.md and continue. At the end, run the Rust tests and tsc, fix what you broke, then commit everything.
"@

$files = Get-ChildItem $queue -Filter '*.md' | Sort-Object Name
foreach ($f in $files) {
  $n = [int]$f.BaseName.Substring(0, 2)
  if ($n -lt $From) { continue }
  $model = $models[$n]; if (-not $model) { $model = 'sonnet' }
  $log = Join-Path $logs "$($f.BaseName).log"

  Write-Host ""
  Write-Host "=== [$n] $($f.BaseName)  ($model)  $(Get-Date -Format 'HH:mm')" -ForegroundColor Cyan

  $prompt = (Get-Content -Raw -Encoding UTF8 $f.FullName) + $suffix
  $cli = @('-p', '--model', $model)
  if ($SkipPermissions) { $cli += '--dangerously-skip-permissions' }
  else { $cli += @('--permission-mode', 'acceptEdits', '--allowedTools') + $allowed }

  $prompt | & claude @cli 2>&1 | Tee-Object -FilePath $log
  $code = $LASTEXITCODE

  if ($code -ne 0) {
    Write-Host "[$n] failed (exit $code). Log: $log" -ForegroundColor Red
    Write-Host "Fix it, then resume with:  .\run-queue.ps1 -From $n" -ForegroundColor Yellow
    exit 1
  }

  # Safety net: commit anything the session left uncommitted
  git add -A | Out-Null
  git diff --cached --quiet
  if ($LASTEXITCODE -ne 0) { git commit -q -m "Build loop $n`: $($f.BaseName) (auto)" }

  Write-Host "[$n] done $(Get-Date -Format 'HH:mm')" -ForegroundColor Green
}

Write-Host ""
Write-Host "Queue finished. Logs in $logs" -ForegroundColor Green
