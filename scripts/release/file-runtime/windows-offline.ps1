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
  # The verifier launches Python by absolute path and audits every child it
  # starts. Include the renderers' companion executables and the exact Python.
  $officeDir = Split-Path -Parent $env:ZEROAGENT_FILE_SOFFICE
  $popplerDir = $env:ZEROAGENT_FILE_POPPLER_BIN
  $applications = @($Python) + @(Get-ChildItem -LiteralPath $officeDir, $popplerDir -File |
    Where-Object { $_.Extension -in @('.exe', '.com') -or $_.Name -eq 'soffice.bin' } | ForEach-Object FullName)
  foreach ($application in $applications) {
    [void](New-NetFirewallRule -DisplayName $group -Group $group -Direction Outbound `
      -Program $application -Action Block -Profile Any)
  }
  [Console]::Error.WriteLine("Windows firewall rules active for $($applications.Count) packaged executables")
  $check = [Diagnostics.Process]::new()
  $check.StartInfo.FileName = $Python
  $check.StartInfo.Arguments = '-IB "{0}" "{1}"' -f $Verifier, $Runtime
  $check.StartInfo.UseShellExecute = $false
  $check.StartInfo.CreateNoWindow = $true
  $check.StartInfo.RedirectStandardOutput = $true
  try {
    if (-not $check.Start()) { throw 'Could not start the bundled Python' }
    $proof = $check.StandardOutput.ReadToEnd()
    $check.WaitForExit()
    if ($check.ExitCode -ne 0) { throw "Bundled Python verification exited $($check.ExitCode)" }
    if (-not $proof) { throw 'Bundled Python returned no verification result' }
    [Console]::Out.Write($proof)
  } finally {
    $check.Dispose()
  }
} finally {
  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  foreach ($profile in $disabledProfiles) {
    Set-NetFirewallProfile -Name $profile.Name -Enabled $profile.Enabled
  }
}
