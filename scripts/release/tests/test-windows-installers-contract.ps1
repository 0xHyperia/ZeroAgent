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

function New-MsiFixture(
    [string]$Path, [string]$ProductName = 'ZeroAgent', [string]$Manufacturer = 'usa0',
    [string]$AllUsers = '1', [string]$ProductVersion = '0.4.0.2',
    [string]$UpgradeCode = ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}')
) {
    $installer = $null; $database = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($Path, 3) # Create a database; never install it.
        $view = $database.OpenView('CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)')
        try { [void]$view.Execute() } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
        foreach ($pair in @(
            @('ProductName', $ProductName), @('Manufacturer', $Manufacturer), @('ALLUSERS', $AllUsers),
            @('ProductCode', ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}')),
            @('UpgradeCode', $UpgradeCode),
            @('ProductVersion', $ProductVersion)
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

function New-ArtifactFixture(
    [string]$Name, [string]$ExtraEntry = '', [string]$ProductName = 'ZeroAgent', [string]$Manufacturer = 'usa0',
    [string]$AllUsers = '1', [string]$ProductVersion = '0.4.0.2',
    [string]$UpgradeCode = ('{' + [Guid]::NewGuid().ToString().ToUpperInvariant() + '}'), [switch]$LegacyPortable
) {
    $directory = Join-Path $fixtureRoot $Name
    [void](New-Item -ItemType Directory -Path $directory)
    New-MsiFixture (Join-Path $directory 'ZeroAgent-test.msi') $ProductName $Manufacturer $AllUsers $ProductVersion $UpgradeCode
    [IO.File]::WriteAllText((Join-Path $directory 'ZeroAgent-test-Setup.exe'), 'This is not an executable. Never run it.')
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::Open((Join-Path $directory 'ZeroAgent-test-portable.zip'), [IO.Compression.ZipArchiveMode]::Create)
    try {
        $names = @('ZeroAgent.exe', 'k-brain.exe', 'k-brain-computer.exe', 'liveagent-gateway.exe', 'browser-extension/background.js', 'browser-extension/manifest.json')
        if ($LegacyPortable) { $names = @('ZeroAgent.exe') }
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

function Invoke-Case([string]$Name, [string]$Directory, [bool]$PlanOnly = $true, [hashtable]$Upgrade = @{}) {
    $destination = Join-Path $fixtureRoot ('report-' + $Name)
    $parameters = @{ ArtifactDir = $Directory; ReportDir = $destination; ExpectedVersion = '0.4.0-beta.2' }
    if ($PlanOnly) { $parameters.DryRun = $true }
    foreach ($key in $Upgrade.Keys) { $parameters[$key] = $Upgrade[$key] }
    $output = @(& $testedScript @parameters 3>$null)
    $report = Get-Content -LiteralPath (Join-Path $destination 'installer-acceptance.json') -Raw | ConvertFrom-Json
    Assert-True ($report.operations.Count -eq 0) "$Name attempted an installer operation"
    Assert-True ($script:startedProcesses -eq 0) "$Name attempted to start a process"
    return $report
}

try {
    $env:GITHUB_ACTIONS = 'false'; $env:CI = 'false'; $env:RUNNER_OS = 'Windows'
    $env:RUNNER_ENVIRONMENT = 'self-hosted'; $env:RUNNER_TEMP = $fixtureRoot
    $sharedUpgradeCode = '{510BFAEC-0BD9-4BAC-AE72-E2975738B401}'
    $valid = New-ArtifactFixture 'valid' -UpgradeCode $sharedUpgradeCode
    $report = Invoke-Case 'plan' $valid
    Assert-True ($report.status -eq 'dry-run' -and -not $report.executionAllowed) 'Valid dry-run must be explicitly non-executing'
    Assert-True ($report.plan.Count -eq 6 -and $report.portablePayloads.Count -eq 6) 'Valid plan must cover both installer cycles and six payloads'
    Assert-True ($report.executionBlockers.Count -ge 3) 'Local dry-run must preserve unmet hosted-runner blockers'
    Assert-True (-not (Test-Path -LiteralPath $report.scratchDirectory)) 'Dry-run must not create the install scratch directory'
    $script:passed++

    $report = Invoke-Case 'runtime-required' $valid $true @{ RequireFileRuntime = $true }
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'missing the required file runtime') 'Release accepted a portable package without its runtime'
    $script:passed++

    $report = Invoke-Case 'host-refusal' $valid $false
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'Refusing actual installation') 'Non-hosted actual execution must fail before reading/installing artifacts'
    $script:passed++

    $previous = New-ArtifactFixture 'previous' -ProductVersion '0.3.23' -UpgradeCode $sharedUpgradeCode -LegacyPortable
    $config = Join-Path $fixtureRoot 'candidate-updater.json'
    '{}' | Set-Content -LiteralPath $config
    $releaseName = 'ZeroAgent-v0.3.23-Windows-x64'
    $releaseUrl = 'https://github.com/USA-Zero/ZeroAgent/releases/download/v0.3.23'
    foreach ($suffix in @('.msi', '-Setup.exe', '-portable.zip')) {
        Copy-Item -LiteralPath (Join-Path $previous "ZeroAgent-test$suffix") -Destination (Join-Path $previous "$releaseName$suffix")
    }
    foreach ($suffix in @('.msi', '-Setup.exe')) {
        'Zml4dHVyZQ==' | Set-Content -LiteralPath (Join-Path $valid "ZeroAgent-test$suffix.sig")
    }
    $manifest = @{
        version = '0.3.23'
        platforms = @{
            'windows-x86_64-msi' = @{ url = "$releaseUrl/$releaseName.msi"; signature = 'Zml4dHVyZQ==' }
            'windows-x86_64-nsis' = @{ url = "$releaseUrl/$releaseName-Setup.exe"; signature = 'Zml4dHVyZQ==' }
        }
    }
    $manifestPath = Join-Path $previous 'latest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
    $upgrade = @{ PreviousArtifactDir = $previous; PreviousVersion = '0.3.23'; UpdaterConfig = $config }
    $report = Invoke-Case 'upgrade-plan' $valid $true $upgrade
    Assert-True ($report.status -eq 'dry-run' -and $report.mode -eq 'upgrade' -and $report.previousVersion -eq '0.3.23') "Valid upgrade plan was refused: $($report.error)"
    Assert-True ($report.plan.Count -eq 9 -and $report.plan[0].signedInstallers -eq 4 -and $report.plan[1].payloadCount -eq 1 -and $report.plan[3].sameDirectory -and $report.plan[7].sameDirectory) 'Upgrade plan omitted signed assets, legacy layout, or same-directory upgrades'
    Assert-True (-not (Test-Path -LiteralPath $report.scratchDirectory)) 'Upgrade dry-run created a scratch directory'
    $script:passed++

    $report = Invoke-Case 'upgrade-host-refusal' $valid $false $upgrade
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'Refusing actual installation') 'Upgrade ran outside a disposable hosted runner'
    $script:passed++

    $report = Invoke-Case 'candidate-legacy-payloads' (New-ArtifactFixture 'candidate-legacy' -LegacyPortable)
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'six expected payload files') 'Candidate accepted legacy one-file layout'
    $script:passed++

    $report = Invoke-Case 'upgrade-missing-inputs' $valid $true @{ PreviousArtifactDir = $previous }
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'required together') 'Partial upgrade inputs were accepted'
    $script:passed++

    $nonUpgrade = $upgrade.Clone()
    $nonUpgrade.PreviousVersion = '0.4.0'
    $report = Invoke-Case 'upgrade-not-newer' $valid $true $nonUpgrade
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'lower Windows base version') 'Equal Windows version was accepted as a prior release'
    $script:passed++

    $manifest.platforms['windows-x86_64-msi'].url = "$releaseUrl/$releaseName.msi?unexpected=true"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath
    $report = Invoke-Case 'upgrade-foreign-asset' $valid $true $upgrade
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'official Windows msi URL') 'Unexpected manifest asset URL was accepted'
    $script:passed++
    $manifest.platforms['windows-x86_64-msi'].url = "$releaseUrl/$releaseName.msi"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath

    $otherMsi = Join-Path $previous 'unrelated.msi'
    New-MsiFixture $otherMsi -ProductVersion '0.3.23'
    Copy-Item -LiteralPath $otherMsi -Destination (Join-Path $previous "$releaseName.msi") -Force
    $report = Invoke-Case 'upgrade-unrelated-msi' $valid $true $upgrade
    Assert-True ($report.status -eq 'failed' -and $report.error -match 'must share UpgradeCode') 'Unrelated MSI was accepted for an in-place upgrade'
    $script:passed++

    # Load only isolated helper definitions, never the entrypoint.
    $tokens = $null; $parseErrors = $null
    $syntax = [Management.Automation.Language.Parser]::ParseFile($testedScript, [ref]$tokens, [ref]$parseErrors)
    Assert-True ($parseErrors.Count -eq 0) 'Installer script must parse cleanly'
    foreach ($functionName in @('Get-SafeFullPath', 'Get-FreshnessBlockers', 'Assert-Below', 'Get-Sha256Bytes', 'New-UpgradeDataFixtures', 'Assert-UpgradeDataFixtures', 'Get-OwnedFiles', 'Test-InstalledPayloads')) {
        $definition = $syntax.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $functionName }, $true)
        Invoke-Expression $definition.Extent.Text
    }
    $legacyInstall = Join-Path $fixtureRoot 'legacy-install-inventory'
    [void](New-Item -ItemType Directory -Path $legacyInstall)
    [IO.File]::WriteAllText((Join-Path $legacyInstall 'liveagent-gateway.exe'), 'unexpected legacy sidecar')
    $script:payloadNames = @('ZeroAgent.exe', 'liveagent-gateway.exe')
    $legacySidecarRejected = $false
    try { Test-InstalledPayloads $legacyInstall 'msi' @{ 'ZeroAgent.exe' = @{} } @{ expectedAuxiliaryFiles = @() } '0.3.23' }
    catch { $legacySidecarRejected = $_.Exception.Message -ceq 'Unexpected installed file: liveagent-gateway.exe' }
    Assert-True $legacySidecarRejected 'Previous one-file release accepted an unreceipted sidecar'
    $script:passed++
    $dataFixture = @(New-UpgradeDataFixtures @(@{ name = 'qa-data'; path = (Join-Path $fixtureRoot 'qa-data') }) 'msi')
    Assert-UpgradeDataFixtures $dataFixture
    'changed' | Set-Content -LiteralPath $dataFixture[0].path
    $changedFixtureRejected = $false
    try { Assert-UpgradeDataFixtures $dataFixture } catch { $changedFixtureRejected = $_.Exception.Message -match 'lost or changed installer QA bytes' }
    Assert-True $changedFixtureRejected 'Changed application-data fixture was not detected'
    $script:passed++
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
