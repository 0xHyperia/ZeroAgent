#requires -Version 5.1
<# Local safety/plan tests only. The fixtures are not installable packages. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$testedScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\test-windows-installers.ps1'))
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('zeroagent-installer-contract-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $fixtureRoot)
$savedEnvironment = @{}
foreach ($name in @('GITHUB_ACTIONS', 'CI', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'RUNNER_TEMP')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$script:startedProcesses = 0
$script:passed = 0

# Defense in depth: even a regression in the script cannot execute an installer.
function global:Start-Process { $script:startedProcesses++; throw 'Test forbids every Start-Process call' }
function global:Stop-Process { throw 'Test forbids every Stop-Process call' }

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function New-MsiFixture([string]$Path, [string]$ProductName = 'ZeroAgent', [string]$Manufacturer = 'usa0', [string]$AllUsers = '1') {
    $installer = $null; $database = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($Path, 3) # Create a database; never install it.
        $view = $database.OpenView('CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)')
        try { [void]$view.Execute() } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
        foreach ($pair in @(
            @('ProductName', $ProductName), @('Manufacturer', $Manufacturer), @('ALLUSERS', $AllUsers),
            @('ProductCode', ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}')),
            @('UpgradeCode', ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}')),
            @('ProductVersion', '0.4.0.2')
        )) {
            $view = $database.OpenView("INSERT INTO ``Property`` (``Property``, ``Value``) VALUES ('$($pair[0])', '$($pair[1])')")
            try { [void]$view.Execute() } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
        }
        [void]$database.Commit()
    } finally {
        if ($database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        if ($installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    }
}

function New-ArtifactFixture([string]$Name, [string]$ExtraEntry = '', [string]$ProductName = 'ZeroAgent', [string]$Manufacturer = 'usa0', [string]$AllUsers = '1') {
    $directory = Join-Path $fixtureRoot $Name
    [void](New-Item -ItemType Directory -Path $directory)
    New-MsiFixture (Join-Path $directory 'ZeroAgent-test.msi') $ProductName $Manufacturer $AllUsers
    [IO.File]::WriteAllText((Join-Path $directory 'ZeroAgent-test-Setup.exe'), 'This is not an executable. Never run it.')
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open((Join-Path $directory 'ZeroAgent-test-portable.zip'), [IO.Compression.ZipArchiveMode]::Create)
    try {
        $names = @('ZeroAgent.exe', 'k-brain.exe', 'k-brain-computer.exe', 'liveagent-gateway.exe', 'browser-extension/background.js', 'browser-extension/manifest.json')
        if ($ExtraEntry) { $names += $ExtraEntry }
        foreach ($entryName in $names) {
            $entry = $zip.CreateEntry($entryName)
            $stream = $entry.Open()
            try {
                $bytes = [Text.Encoding]::ASCII.GetBytes(('fixture:' + $entryName + ':__TAURI_BUNDLE_TYPE_VAR_UNK'))
                $stream.Write($bytes, 0, $bytes.Length)
            } finally { $stream.Dispose() }
        }
    } finally { $zip.Dispose() }
    return $directory
}

function Invoke-Case([string]$Name, [string]$Directory, [bool]$PlanOnly = $true) {
    $destination = Join-Path $fixtureRoot ('report-' + $Name)
    $parameters = @{ ArtifactDir = $Directory; ReportDir = $destination; ExpectedVersion = '0.4.0-beta.2' }
    if ($PlanOnly) { $parameters.DryRun = $true }
    $output = @(& $testedScript @parameters 3>$null)
    $report = Get-Content -LiteralPath (Join-Path $destination 'installer-acceptance.json') -Raw | ConvertFrom-Json
    Assert-True ($report.operations.Count -eq 0) "$Name attempted an installer operation"
    Assert-True ($script:startedProcesses -eq 0) "$Name attempted to start a process"
    return $report
}

try {
    $env:GITHUB_ACTIONS = 'false'; $env:CI = 'false'; $env:RUNNER_OS = 'Windows'
    $env:RUNNER_ENVIRONMENT = 'self-hosted'; $env:RUNNER_TEMP = $fixtureRoot
    $valid = New-ArtifactFixture 'valid'
    $report = Invoke-Case 'plan' $valid
    Assert-True ($report.status -eq 'dry-run' -and -not $report.executionAllowed) 'Valid dry-run must be explicitly non-executing'
    Assert-True ($report.plan.Count -eq 6 -and $report.portablePayloads.Count -eq 6) 'Valid plan must cover both installer cycles and six payloads'
    Assert-True ($report.executionBlockers.Count -ge 3) 'Local dry-run must preserve unmet hosted-runner blockers'
    Assert-True (-not (Test-Path -LiteralPath $report.scratchDirectory)) 'Dry-run must not create the install scratch directory'
    $script:passed++

    $report = Invoke-Case 'host-refusal' $valid $false
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'Refusing actual installation') 'Non-hosted actual execution must fail before reading/installing artifacts'
    $script:passed++

    # Load only these two pure/read-only function definitions, never the entrypoint.
    $tokens = $null; $parseErrors = $null
    $syntax = [Management.Automation.Language.Parser]::ParseFile($testedScript, [ref]$tokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) 'Installer script must parse cleanly'
    foreach ($functionName in @('Get-SafeFullPath', 'Get-FreshnessBlockers')) {
        $definition = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
        Invoke-Expression $definition.Extent.Text
    }
    $ownedDirectory = Join-Path $fixtureRoot 'owned-nsis-app'
    $state = @{
        registrations = @(@{ kind = 'vendor'; hive = 'CurrentUser'; view = 'Registry64'; key = 'SOFTWARE\usa0\ZeroAgent'; installLocation = $ownedDirectory })
        processes = @(); relatedMsiProducts = @(); exactMsiProductState = -1; existingInstallDirectories = @()
    }
    Assert-True (@(Get-FreshnessBlockers $state).Count -eq 1) 'Vendor residue must block every fresh installation'
    Assert-True (@(Get-FreshnessBlockers $state $ownedDirectory).Count -eq 0) 'NSIS cleanup may retain only its exact owned install-directory preference'
    $script:passed++
    $state.registrations[0].installLocation = Join-Path $fixtureRoot 'other-app'
    Assert-True (@(Get-FreshnessBlockers $state $ownedDirectory).Count -eq 1) 'Foreign vendor install-directory preference must block cleanup success'
    $state.registrations[0].installLocation = $ownedDirectory
    $state.registrations[0].kind = 'uninstall'
    Assert-True (@(Get-FreshnessBlockers $state $ownedDirectory).Count -eq 1) 'An uninstall registration can never use the vendor-residue exception'
    $script:passed++

    foreach ($badEntry in @('../escape.exe', 'C:/escape.exe', 'browser-extension/../../escape.exe', 'ZEROAGENT.EXE', 'unexpected.txt')) {
        $name = 'unsafe-' + $script:passed
        $report = Invoke-Case $name (New-ArtifactFixture $name $badEntry)
        Assert-True ($report.status -eq 'failed' -and $report.error -match 'portable ZIP') "Unsafe ZIP entry was accepted: $badEntry"
        $script:passed++
    }
    foreach ($identity in @(@('LiveAgent', 'usa0', '1'), @('ZeroAgent', 'other-publisher', '1'), @('ZeroAgent', 'usa0', '2'))) {
        $name = 'identity-' + $script:passed
        $report = Invoke-Case $name (New-ArtifactFixture $name '' $identity[0] $identity[1] $identity[2])
        Assert-True ($report.status -eq 'failed' -and $report.error -match 'MSI must identify') 'Unexpected MSI identity or ALLUSERS scope was accepted'
        $script:passed++
    }
    $secondMsi = Join-Path $valid 'Second.msi'
    [IO.File]::WriteAllText($secondMsi, 'Duplicate selection must fail before database access')
    $report = Invoke-Case 'duplicate-msi' $valid
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'exactly one') 'Ambiguous installer selection was accepted'
    $script:passed++

    $outsideReport = Join-Path (Split-Path $fixtureRoot -Parent) ('outside-' + [Guid]::NewGuid().ToString('N'))
    $output = @(& $testedScript -ArtifactDir $valid -ReportDir $outsideReport -ExpectedVersion '0.4.0-beta.2' -DryRun 3>$null)
    $report = $output[-1] | ConvertFrom-Json
    Assert-True ($report.status -eq 'failed' -and -not (Test-Path -LiteralPath $outsideReport)) 'ReportDir escaped the allowed temporary root'
    $script:passed++
    Write-Output ([ordered]@{ status = 'passed'; cases = $script:passed; installerProcessesStarted = $script:startedProcesses; fixtures = $fixtureRoot } | ConvertTo-Json -Compress)
} finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
    Remove-Item -LiteralPath Function:\Start-Process -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath Function:\Stop-Process -ErrorAction SilentlyContinue
    # Preserve fixtures and reports. Never recursively delete any directory.
}
