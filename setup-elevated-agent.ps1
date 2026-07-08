# Run the Mirror host agent ELEVATED (high integrity) so remote input works over
# elevated windows such as Task Manager. Windows UIPI blocks a normal-privilege
# process from injecting input into a higher-privilege window, which is why the
# keyboard dies while Task Manager (auto-elevated) has focus.
#
# This script self-elevates (UAC prompt), then registers a scheduled task that
# starts the agent elevated at every logon (no further UAC prompts). It does NOT
# disable or weaken UAC.
#
# HARD LIMIT (Windows secure desktop, cannot be bypassed even elevated):
#   the UAC consent dialog, Ctrl+Alt+Del, and the lock/logon screen stay
#   uncontrollable remotely.
#
# Usage (once, ON the home PC):
#   powershell -ExecutionPolicy Bypass -File "setup-elevated-agent.ps1"
#   -> click "Yes" on the UAC prompt.

$ErrorActionPreference = 'Stop'

# --- Self-elevate: relaunch this script as administrator if not already. -------
$principalCheck = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Not elevated. Launching a UAC prompt to run as administrator..." -ForegroundColor Yellow
  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    )
  } catch {
    Write-Host "UAC was cancelled or denied. Nothing was changed." -ForegroundColor Red
  }
  return
}

# --- Elevated from here. ------------------------------------------------------
$repo = Split-Path -Parent $PSCommandPath
$agentScript = Join-Path $repo 'run-agent.ps1'
if (-not (Test-Path $agentScript)) {
  Write-Host "run-agent.ps1 not found at $agentScript" -ForegroundColor Red
  Read-Host "Press Enter to close"
  return
}

$taskName = 'MirrorHostAgent'
$user = "$env:USERDOMAIN\$env:USERNAME"

Write-Host "Stopping any agent that is already running..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'mirror_host_agent' } |
  ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
  }

$action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "run-agent.ps1"' `
  -WorkingDirectory $repo

# At logon, run in the interactive user session at highest run level so SendInput
# reaches the active desktop.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$taskPrincipal = New-ScheduledTaskPrincipal `
  -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action -Trigger $trigger `
  -Principal $taskPrincipal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "DONE. Registered and started '$taskName' (elevated, at logon)." -ForegroundColor Green
Write-Host " - Remote keyboard/mouse now works while Task Manager and other elevated windows are focused." -ForegroundColor Green
Write-Host " - The agent auto-starts elevated at every logon (no UAC prompt after this)." -ForegroundColor Green
Write-Host " - Still NOT controllable remotely: UAC dialog, Ctrl+Alt+Del, lock/logon screen (secure desktop)." -ForegroundColor Yellow
Write-Host ""
Write-Host "To undo:  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:`$false" -ForegroundColor DarkGray
Read-Host "Press Enter to close"
