# Smoke-tests a dev build of Shouldertap.exe on a real Windows desktop (CI's
# Windows runner) against a deployed stack: pairs it, sends taps, answers with
# the keyboard like a person would, and screenshots each step into $Out.
#
#   pwsh scripts/smoke.ps1 -Server https://<preview>.workers.dev -Exe target\debug\Shouldertap.exe
param(
  [Parameter(Mandatory)] [string] $Server,
  [Parameter(Mandatory)] [string] $Exe,
  [string] $Out = "smoke"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$failures = @()

function Shot([string] $name) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  Write-Host "  screenshot $name.png"
}

function Api([string] $method, [string] $path, $body, [string] $token) {
  $headers = @{}
  if ($token) { $headers.Authorization = "Bearer $token" }
  $json = if ($body) { $body | ConvertTo-Json -Compress -Depth 5 } else { $null }
  Invoke-RestMethod -Method $method -Uri "$Server$path" -Headers $headers -Body $json -ContentType "application/json"
}

function Check([string] $what, [scriptblock] $test, [int] $seconds = 15) {
  $deadline = (Get-Date).AddSeconds($seconds)
  do {
    if (& $test) { Write-Host "ok   $what"; return }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  Write-Host "FAIL $what"
  $script:failures += $what
}

function TapState([string] $id) {
  (Api GET "/v1/me" $null $device).taps | Where-Object { $_.id -eq $id }
}

function Alive { -not $app.HasExited }

Write-Host "==> Pairing a PC with $Server"
$grant = Api POST "/v1/inboxes" @{ recipientName = "Smoke"; deviceName = "CI PC"; platform = "windows" }
$device = $grant.token
$invite = Api POST "/v1/invites" @{ kind = "sender" } $device
$sender = (Api POST "/v1/invites/redeem" @{ code = $invite.code; name = "Rosa"; color = "tomato" }).token
# Dev builds keep their pairing in "Shouldertap Debug"; a credential left in
# the file moves into Credential Manager on first launch.
$data = Join-Path $env:LOCALAPPDATA "Shouldertap Debug"
New-Item -ItemType Directory -Force -Path $data | Out-Null
Set-Content -Path (Join-Path $data "credential.secret") -Value $device -NoNewline

Write-Host "==> Launching"
$env:SHOULDERTAP_SERVER_URL = $Server
$app = Start-Process -FilePath $Exe -PassThru -RedirectStandardOutput (Join-Path $Out "stdout.log") -RedirectStandardError (Join-Path $Out "stderr.log")
Check "the inbox lists it as a Windows PC" {
  ((Api GET "/v1/me" $null $device).credentials | Where-Object { $_.id -eq $grant.credentialId }).platform -eq "windows"
} 5
# Reading the pairing proves it started; the first overlay proves it connected.
Check "the credential moved into Credential Manager" { -not (Test-Path (Join-Path $data "credential.secret")) } 60
Start-Sleep -Seconds 5
Check "is running" { Alive } 1
Shot "01-idle"

Write-Host "==> A tap arrives"
$tap = Api POST "/v1/taps" @{ requestId = "smoke-tap-0000001"; body = "Dinner's ready, come down!" } $sender
Check "the overlay reports it displayed" { (TapState $tap.id).displayedAt } 20
Start-Sleep -Seconds 1
Shot "02-overlay"
$foreground = Add-Type -PassThru -Name Fg -Namespace Smoke -MemberDefinition @'
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(System.IntPtr hWnd, out int pid);
'@
$fgPid = 0; [void] $foreground::GetWindowThreadProcessId($foreground::GetForegroundWindow(), [ref] $fgPid)
Check "the overlay took keyboard focus" { $fgPid -eq $app.Id } 1

Write-Host "==> Answering with the 1 key (On it)"
[System.Windows.Forms.SendKeys]::SendWait("1")
Check "the answer reached the server" { (TapState $tap.id).response.kind -eq "on_it" } 20
Start-Sleep -Seconds 1
Shot "03-answered"

Write-Host "==> Replying with 3, typing, Enter"
$second = Api POST "/v1/taps" @{ requestId = "smoke-tap-0000002"; body = "Can you grab the mail?" } $sender
Check "the second overlay is up" { (TapState $second.id).displayedAt } 20
Start-Sleep -Seconds 1
[System.Windows.Forms.SendKeys]::SendWait("3")
Start-Sleep -Milliseconds 700
[System.Windows.Forms.SendKeys]::SendWait("On my way")
Start-Sleep -Milliseconds 300
Shot "04-reply"
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Check "the typed reply reached the server" { (TapState $second.id).response.text -eq "On my way" } 20

Write-Host "==> Answered elsewhere: the overlay closes"
$third = Api POST "/v1/taps" @{ requestId = "smoke-tap-0000003"; body = "Laundry!" } $sender
Check "the third overlay is up" { (TapState $third.id).displayedAt } 20
Api POST "/v1/taps/$($third.id)/acknowledge" @{ response = @{ kind = "in_10" } } $device | Out-Null
Start-Sleep -Seconds 2
Shot "05-dismissed-elsewhere"

Write-Host "==> Launching again opens the menu"
Start-Process -FilePath $Exe | Out-Null
Start-Sleep -Seconds 4
Check "the second copy handed off and quit" { @(Get-Process -Name Shouldertap -ErrorAction SilentlyContinue).Count -eq 1 } 10
Shot "06-menu"

$app.Refresh()
$memory = [math]::Round($app.WorkingSet64 / 1MB, 1)
$private = [math]::Round($app.PrivateMemorySize64 / 1MB, 1)
Write-Host "==> Memory (dev build): working set $memory MB, private $private MB"
"working set $memory MB, private $private MB" | Set-Content (Join-Path $Out "memory.txt")
Check "still running after all that" { Alive } 1

Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
if ($failures.Count -gt 0) {
  Write-Host "`n$($failures.Count) check(s) failed:"; $failures | ForEach-Object { Write-Host "  - $_" }
  Get-Content (Join-Path $Out "stderr.log") -Tail 40 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host "`nAll checks passed."
