param(
  [Parameter(Mandatory)] [string] $Runtime,
  [Parameter(Mandatory)] [string] $Python,
  [Parameter(Mandatory)] [string] $Verifier
)

$ErrorActionPreference = 'Stop'
$group = "ZeroAgent-File-Runtime-QA-$([Guid]::NewGuid())"
$disabledProfiles = @()
try {
  $disabledProfiles = @(Get-NetFirewallProfile | Where-Object { $_.Enabled -ne 'True' })
  foreach ($profile in $disabledProfiles) {
    Set-NetFirewallProfile -Name $profile.Name -Enabled True
  }
  $applications = @(Get-ChildItem -LiteralPath $Runtime -Recurse -File |
    Where-Object { $_.Extension -in @('.exe', '.com') -or $_.Name -eq 'soffice.bin' } | ForEach-Object FullName)
  if ($Python -notin $applications) { throw 'The packaged Python must be covered by the firewall.' }
  foreach ($application in $applications) {
    [void](New-NetFirewallRule -DisplayName $group -Group $group -Direction Outbound `
      -Program $application -Action Block -Profile Any)
  }
  & $Python -IB $Verifier $Runtime
  exit $LASTEXITCODE
} finally {
  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($profile in $disabledProfiles) {
    Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled
  }
}
