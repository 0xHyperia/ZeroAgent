#requires -Version 5.1
<#
.SYNOPSIS
Tests fresh ZeroAgent MSI/NSIS installation and removal on a disposable hosted runner.
.DESCRIPTION
The caller must first verify the downloaded installer signatures. This script never
launches ZeroAgent, kills processes, changes security settings, or removes directories.
Real execution requires all four hosted-runner environment gates, a fresh machine,
and an elevated Windows session. There is deliberately no override switch.

ReportDir must be an empty/new directory below RUNNER_TEMP (the system temporary
directory is also allowed for local DryRun). DryRun reads artifacts and MSI metadata,
then writes a plan only. A dry-run report is never evidence of installation success.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ArtifactDir,
    [Parameter(Mandatory = $true)][string]$ReportDir,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:reportPath = $null
$script:report = [ordered]@{
    schemaVersion = 1
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
    status = 'failed'
    dryRun = [bool]$DryRun
    expectedVersion = $ExpectedVersion
    executionBlockers = @()
    artifacts = @()
    plan = @()
    phases = @()
    operations = @()
    error = $null
}
$script:payloadNames = @(
    'ZeroAgent.exe', 'k-brain.exe', 'k-brain-computer.exe', 'liveagent-gateway.exe',
    'browser-extension/background.js', 'browser-extension/manifest.json'
)

function Get-SafeFullPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '["\x00-\x1f]' -or
        $Path -match '(^|[\\/])\.\.?([\\/]|$)' -or $Path.StartsWith('\\') -or
        $Path -notmatch '^[A-Za-z]:[\\/]') {
        throw "Only absolute local Windows paths without traversal, UNC, or control characters are allowed: $Path"
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full.Length -le 2) { throw 'A drive root is not an allowed artifact or temporary directory' }
    if ($full.Substring(2).Contains(':')) { throw "Alternate data stream paths are forbidden: $Path" }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are forbidden in the path or its ancestors: $cursor"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $full
}

function Assert-Below([string]$Path, [string]$Parent) {
    if (-not $Path.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path must be strictly below the allowed temporary directory: $Path"
    }
}

function Get-EnvironmentBlockers {
    $blockers = @()
    foreach ($gate in @(
        @('GITHUB_ACTIONS', $env:GITHUB_ACTIONS, 'true'), @('CI', $env:CI, 'true'),
        @('RUNNER_OS', $env:RUNNER_OS, 'Windows'),
        @('RUNNER_ENVIRONMENT', $env:RUNNER_ENVIRONMENT, 'github-hosted')
    )) {
        if ($gate[1] -cne $gate[2]) { $blockers += "$($gate[0]) must equal $($gate[2])" }
    }
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { $blockers += 'Windows is required' }
    if (-not $env:RUNNER_TEMP) { $blockers += 'RUNNER_TEMP is required' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            $blockers += 'An elevated disposable runner session is required for ALLUSERS=1 MSI'
        }
    } finally { $identity.Dispose() }
    return $blockers
}

function Get-MsiMetadata([string]$Path) {
    $installer = $null; $database = $null; $view = $null
    try {
        $installer = New-Object -ComObject WindowsInstaller.Installer
        $database = $installer.OpenDatabase($Path, 0) # 0 = read-only; never Win32_Product.
        $view = $database.OpenView('SELECT `Property`, `Value` FROM `Property`')
        [void]$view.Execute()
        $properties = @{}
        while ($record = $view.Fetch()) {
            try { $properties[$record.StringData(1)] = $record.StringData(2) }
            finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
        foreach ($required in @('ProductName', 'Manufacturer', 'ProductCode', 'UpgradeCode', 'ProductVersion', 'ALLUSERS')) {
            if (-not $properties.ContainsKey($required)) { throw "MSI is missing $required" }
        }
        if ($properties.ProductName -cne 'ZeroAgent' -or $properties.Manufacturer -cne 'usa0' -or $properties.ALLUSERS -cne '1') {
            throw 'MSI must identify ZeroAgent / usa0 and ALLUSERS=1'
        }
        foreach ($key in @('ProductCode', 'UpgradeCode')) {
            if ($properties[$key] -notmatch '^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$') {
                throw "MSI $key is not a canonical product GUID"
            }
        }
        if ($properties.ProductVersion -notmatch ('^' + [regex]::Escape(($ExpectedVersion -split '-')[0]) + '(\.\d+)?$')) {
            throw 'MSI numeric ProductVersion does not match the expected release base version'
        }
        [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view); $view = $null
        $view = $database.OpenView('SELECT `Name` FROM `_Tables`')
        [void]$view.Execute()
        $hasShortcutTable = $false
        while ($record = $view.Fetch()) {
            try { if ($record.StringData(1) -ceq 'Shortcut') { $hasShortcutTable = $true } }
            finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
        }
        $auxiliaryFiles = @()
        if ($hasShortcutTable) {
            [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view); $view = $null
            $view = $database.OpenView('SELECT `Directory_`, `Name`, `Arguments` FROM `Shortcut`')
            [void]$view.Execute()
            while ($record = $view.Fetch()) {
                try {
                    if ($record.StringData(1) -ceq 'INSTALLDIR') {
                        $shortcutName = ($record.StringData(2) -split '\|')[-1]
                        if ($shortcutName -cne 'Uninstall ZeroAgent' -or $record.StringData(3) -cne '/x [ProductCode]') {
                            throw 'Unexpected MSI shortcut in the installation directory'
                        }
                        $auxiliaryFiles += 'Uninstall ZeroAgent.lnk'
                    }
                } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
            }
        }
        return [ordered]@{
            productName = $properties.ProductName; manufacturer = $properties.Manufacturer
            productCode = $properties.ProductCode; upgradeCode = $properties.UpgradeCode
            productVersion = $properties.ProductVersion; allUsers = $properties.ALLUSERS
            databaseMode = 'read-only'; expectedAuxiliaryFiles = $auxiliaryFiles
        }
    } finally {
        if ($view) { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
        if ($database) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
        if ($installer) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    }
}

function Get-ProductRegistrations {
    $registrations = @()
    foreach ($hiveName in @('CurrentUser', 'LocalMachine')) {
        foreach ($viewName in @('Registry64', 'Registry32')) {
            $hive = [Microsoft.Win32.RegistryHive]::$hiveName
            $registryView = [Microsoft.Win32.RegistryView]::$viewName
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $registryView)
            try {
                $uninstall = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', $false)
                if ($uninstall) {
                    try {
                        foreach ($name in $uninstall.GetSubKeyNames()) {
                            $key = $uninstall.OpenSubKey($name, $false)
                            if (-not $key) { throw "Cannot inspect uninstall registration $name" }
                            try {
                                $displayName = [string]$key.GetValue('DisplayName', '')
                                if ($displayName -match '(?i)zeroagent|liveagent' -or $name -match '(?i)zeroagent|liveagent') {
                                    $registrations += [ordered]@{
                                        kind = 'uninstall'; hive = $hiveName; view = $viewName; key = $name
                                        displayName = $displayName; publisher = [string]$key.GetValue('Publisher', '')
                                        displayVersion = [string]$key.GetValue('DisplayVersion', '')
                                        installLocation = [string]$key.GetValue('InstallLocation', '')
                                        uninstallString = [string]$key.GetValue('UninstallString', '')
                                        windowsInstaller = $key.GetValue('WindowsInstaller', $null)
                                    }
                                }
                            } finally { $key.Dispose() }
                        }
                    } finally { $uninstall.Dispose() }
                }
                foreach ($vendorPath in @('SOFTWARE\usa0\ZeroAgent', 'SOFTWARE\usa0\LiveAgent')) {
                    $vendor = $base.OpenSubKey($vendorPath, $false)
                    if ($vendor) {
                        try {
                            $registrations += [ordered]@{
                                kind = 'vendor'; hive = $hiveName; view = $viewName; key = $vendorPath
                                installLocation = [string]$vendor.GetValue('InstallDir', [string]$vendor.GetValue('', ''))
                            }
                        } finally { $vendor.Dispose() }
                    }
                }
            } finally { $base.Dispose() }
        }
    }
    return $registrations
}

function Get-ProductProcesses {
    # Read public process identity only. Do not read command lines or credentials.
    $filter = "Name='zeroagent.exe' OR Name='liveagent.exe' OR Name='k-brain.exe' OR Name='k-brain-computer.exe' OR Name='liveagent-gateway.exe'"
    return @(Get-CimInstance -ClassName Win32_Process -Filter $filter | ForEach-Object {
        [ordered]@{ processId = $_.ProcessId; name = $_.Name; executablePath = $_.ExecutablePath }
    })
}

function Get-FreshnessState($Metadata) {
    $installer = New-Object -ComObject WindowsInstaller.Installer
    try {
        $related = @($installer.RelatedProducts($Metadata.upgradeCode))
        $productState = [int]$installer.ProductState($Metadata.productCode)
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    $paths = @()
    foreach ($basePath in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($basePath) {
            foreach ($name in @('ZeroAgent', 'LiveAgent', 'Programs\ZeroAgent', 'Programs\LiveAgent')) {
                $candidate = Join-Path $basePath $name
                if (Test-Path -LiteralPath $candidate) { $paths += $candidate }
            }
        }
    }
    return [ordered]@{
        registrations = @(Get-ProductRegistrations); processes = @(Get-ProductProcesses)
        relatedMsiProducts = $related; exactMsiProductState = $productState
        existingInstallDirectories = $paths
    }
}

function Get-FreshnessBlockers($State, [string]$AllowedVendorDirectory = '') {
    $blockers = @()
    $blockingRegistrations = @($State.registrations | Where-Object {
        if ($AllowedVendorDirectory -and $_.kind -eq 'vendor' -and $_.hive -eq 'CurrentUser' -and
            $_.key -ieq 'SOFTWARE\usa0\ZeroAgent') {
            # NSIS intentionally retains this install-directory preference unless the
            # user requests deletion of app data. Never request or emulate that action.
            (Get-SafeFullPath $_.installLocation.Trim('"')) -ine $AllowedVendorDirectory
        } else { $true }
    })
    if ($blockingRegistrations.Count) { $blockers += 'Existing ZeroAgent/LiveAgent product registration' }
    if ($State.processes.Count) { $blockers += 'Existing ZeroAgent/LiveAgent or shared helper process' }
    if ($State.relatedMsiProducts.Count -or $State.exactMsiProductState -ne -1) { $blockers += 'Existing or advertised related MSI product' }
    if ($State.existingInstallDirectories.Count) { $blockers += 'Existing ZeroAgent/LiveAgent installation directory' }
    return $blockers
}

function Get-Sha256Bytes([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-MainMarker([byte[]]$Bytes) {
    $prefix = '__TAURI_BUNDLE_TYPE_VAR_'
    $ascii = [Text.Encoding]::ASCII.GetString($Bytes)
    $offset = $ascii.IndexOf($prefix, [StringComparison]::Ordinal)
    if ($offset -lt 0 -or $ascii.IndexOf($prefix, $offset + $prefix.Length, [StringComparison]::Ordinal) -ge 0 -or
        $offset + $prefix.Length + 3 -gt $Bytes.Length) { throw 'Main executable must contain exactly one Tauri bundle marker' }
    return [ordered]@{ offset = $offset + $prefix.Length; value = $ascii.Substring($offset + $prefix.Length, 3) }
}

function Get-PortableInventory([string]$Path) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $inventory = @{}; $seen = @{}; [long]$total = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if ($name -match '^/|:|(^|/)\.\.?(/|$)|//|[\x00-\x1f]' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Unsafe portable ZIP entry: $name" }
            if ($seen.ContainsKey($name)) { throw "Duplicate portable ZIP entry: $name" }
            $seen[$name] = $true
            if ($name.EndsWith('/')) {
                if ($name -cne 'browser-extension/' -or $entry.Length -ne 0) { throw "Unexpected portable ZIP directory: $name" }
                continue
            }
            if ($script:payloadNames -notcontains $name) { throw "Unexpected portable ZIP file: $name" }
            $total += $entry.Length
            if ($entry.Length -le 0 -or $entry.Length -gt 536870912 -or $total -gt 2147483648) { throw 'Portable ZIP exceeds payload size limits or contains an empty file' }
            $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
            try {
                $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
            } finally { $sha.Dispose(); $stream.Dispose() }
            $item = [ordered]@{ relativePath = $name; bytes = $entry.Length; sha256 = $hash }
            if ($name -ieq 'ZeroAgent.exe') {
                $stream = $entry.Open(); $memory = New-Object IO.MemoryStream
                try { $stream.CopyTo($memory); $marker = Get-MainMarker $memory.ToArray() }
                finally { $memory.Dispose(); $stream.Dispose() }
                if ($marker.value -cne 'UNK') { throw 'Portable main executable must have the UNK Tauri bundle marker' }
                $item.marker = $marker
            }
            $inventory[$name] = $item
        }
        if ($inventory.Count -ne 6) { throw 'Portable ZIP must contain exactly the six expected payload files' }
        foreach ($name in $script:payloadNames) { if (-not $inventory.ContainsKey($name)) { throw "Missing portable payload $name" } }
        return $inventory
    } finally { $zip.Dispose() }
}

function Get-OwnedFiles([string]$InstallDir) {
    $root = Get-SafeFullPath $InstallDir
    if (-not (Test-Path -LiteralPath $root)) { return @() }
    $files = @()
    # Do not recurse through an unvalidated directory or a junction created by an installer.
    foreach ($item in Get-ChildItem -LiteralPath $root -Force) {
        [void](Get-SafeFullPath $item.FullName)
        if ($item.PSIsContainer) {
            if ($item.Name -cne 'browser-extension') { throw "Unexpected installed directory: $($item.Name)" }
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
                [void](Get-SafeFullPath $child.FullName)
                if ($child.PSIsContainer) { throw 'Unexpected nested installed payload directory' }
                $files += [ordered]@{ relativePath = "browser-extension/$($child.Name)"; bytes = $child.Length; sha256 = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
            }
        } else {
            $files += [ordered]@{ relativePath = $item.Name; bytes = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        }
    }
    return $files
}

function Assert-OwnedRegistration($State, [string]$Kind, [string]$InstallDir, $Metadata) {
    $entries = @($State.registrations | Where-Object { $_.kind -eq 'uninstall' })
    if (-not $entries.Count) { throw "$Kind did not create an uninstall registration" }
    foreach ($entry in $entries) {
        if ($entry.displayName -cne 'ZeroAgent' -or $entry.publisher -cne 'usa0' -or
            (Get-SafeFullPath $entry.installLocation.Trim('"')) -ine $InstallDir) { throw "$Kind registration is not owned by this exact installation directory" }
        if ($Kind -eq 'msi' -and ($entry.key -ine $Metadata.productCode -or $entry.hive -ne 'LocalMachine' -or $entry.windowsInstaller -ne 1)) {
            throw 'MSI registration does not match the exact machine ProductCode installed by this run'
        }
        if ($Kind -eq 'nsis' -and ($entry.hive -ne 'CurrentUser' -or $entry.key -ine 'ZeroAgent')) { throw 'NSIS must create the fresh HKCU ZeroAgent registration' }
    }
    foreach ($vendor in @($State.registrations | Where-Object { $_.kind -eq 'vendor' })) {
        if ((Get-SafeFullPath $vendor.installLocation.Trim('"')) -ine $InstallDir) { throw 'Vendor registration points outside the owned installation directory' }
    }
}

function Test-InstalledPayloads([string]$InstallDir, [string]$Kind, $Portable, $Metadata) {
    $result = @()
    $ownedFiles = @(Get-OwnedFiles $InstallDir)
    foreach ($file in $ownedFiles) {
        $allowedAuxiliary = ($Kind -eq 'nsis' -and $file.relativePath -ieq 'uninstall.exe') -or
            ($Kind -eq 'msi' -and $Metadata.expectedAuxiliaryFiles -contains $file.relativePath)
        if ($script:payloadNames -notcontains $file.relativePath -and -not $allowedAuxiliary) {
            throw "Unexpected installed file: $($file.relativePath)"
        }
    }
    foreach ($name in $script:payloadNames) {
        $path = Get-SafeFullPath (Join-Path $InstallDir $name)
        Assert-Below $path $InstallDir
        $file = Get-Item -LiteralPath $path
        $portableFile = $Portable[$name]
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        $check = [ordered]@{ relativePath = $name; bytes = $file.Length; sha256 = $hash; portableSha256 = $portableFile.sha256; rawSha256MatchesPortable = ($hash -ceq $portableFile.sha256) }
        if ($file.Length -ne $portableFile.bytes) { throw "$name has an unexpected installed length" }
        if ($name -ieq 'ZeroAgent.exe') {
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($path).ProductVersion
            if ($version -cne $ExpectedVersion) { throw "Installed main ProductVersion '$version' does not equal '$ExpectedVersion'" }
            $check.productVersion = $version
            $bytes = [IO.File]::ReadAllBytes($path); $marker = Get-MainMarker $bytes
            $expectedMarker = if ($Kind -eq 'msi') { 'MSI' } else { 'NSS' }
            if ($marker.offset -ne $portableFile.marker.offset -or $marker.value -cne $expectedMarker) { throw 'Installed main Tauri marker is not the expected installer marker' }
            [Array]::Copy([Text.Encoding]::ASCII.GetBytes('UNK'), 0, $bytes, $marker.offset, 3)
            $normalizedHash = Get-Sha256Bytes $bytes
            if ($normalizedHash -cne $portableFile.sha256) { throw 'Main executable differs from portable beyond the three-byte Tauri bundle marker' }
            $check.installedMarker = $marker.value; $check.portableMarker = 'UNK'
            $check.normalizedSha256 = $normalizedHash; $check.onlyTauriMarkerDiffers = $true
        } elseif ($hash -cne $portableFile.sha256) { throw "$name does not byte-match the portable payload" }
        $result += $check
    }
    return [ordered]@{ payloads = $result; ownedFiles = $ownedFiles }
}

function Invoke-OwnedProcess([string]$FilePath, [string]$Arguments, [string]$Operation) {
    if ($DryRun) { throw 'Internal error: DryRun cannot start processes' }
    $gates = @(Get-EnvironmentBlockers)
    if ($gates.Count) { throw ($gates -join '; ') }
    [void](Get-SafeFullPath $FilePath)
    $start = [DateTime]::UtcNow
    # -Wait waits the process tree, including NSIS's copied temporary uninstaller.
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -Wait -WindowStyle Hidden
    $operationResult = [ordered]@{
        operation = $Operation; executable = $FilePath; arguments = $Arguments
        processId = $process.Id; exitCode = $process.ExitCode
        startedAtUtc = $start.ToString('o'); completedAtUtc = [DateTime]::UtcNow.ToString('o')
        waitMode = 'Start-Process -Wait (process tree)'
        rebootRequired = ($process.ExitCode -eq 3010 -or $process.ExitCode -eq 1641)
    }
    $script:report.operations += $operationResult
    return $operationResult
}

function Wait-OwnedRemoval([string]$InstallDir, [string]$Kind, $Metadata) {
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    do {
        $state = Get-FreshnessState $Metadata
        $files = @(Get-OwnedFiles $InstallDir)
        $allowedVendorDirectory = if ($Kind -eq 'nsis') { $InstallDir } else { '' }
        $blockers = @(Get-FreshnessBlockers $state $allowedVendorDirectory)
        if (-not $files.Count -and -not $blockers.Count) {
            return [ordered]@{
                state = $state; ownedFiles = $files; uninstallRegistrationsCleared = $true
                retainedOwnedVendorRegistrations = @($state.registrations | Where-Object { $_.kind -eq 'vendor' })
                vendorRegistryPolicy = 'NSIS may retain only the current-user installation-directory preference pointing to this exact owned directory; app-data deletion is never requested'
            }
        }
        Start-Sleep -Milliseconds 1000
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Uninstaller did not clear uninstall registrations, related MSI state, processes, and all owned files within 120 seconds'
}

function Invoke-InstallerCycle([string]$Kind, [string]$InstallerPath, [string]$InstallDir, $Metadata, $Portable) {
    $phase = [ordered]@{ kind = $Kind; installDirectory = $InstallDir; status = 'failed'; ownershipProved = $false; error = $null; cleanupError = $null }
    $script:report.phases += $phase
    $phase.before = Get-FreshnessState $Metadata
    $blockers = @(Get-FreshnessBlockers $phase.before)
    if ($blockers.Count) { throw ($blockers -join '; ') }
    if (Test-Path -LiteralPath $InstallDir) { throw 'Fresh installation directory already exists' }
    try {
        if ($Kind -eq 'msi') {
            $installArgs = '/i "' + $InstallerPath + '" /qn /norestart INSTALLDIR="' + $InstallDir + '" /l*v "' + (Join-Path $ReportDir 'msi-install.log') + '"'
            $installed = Invoke-OwnedProcess $script:msiexec $installArgs 'msi-install'
        } else {
            # NSIS requires /D= to be the final argument and not enclosed in quotes.
            $installed = Invoke-OwnedProcess $InstallerPath ('/S /D=' + $InstallDir) 'nsis-install'
        }
        $phase.installExitCode = $installed.exitCode
        $phase.afterInstall = Get-FreshnessState $Metadata
        Assert-OwnedRegistration $phase.afterInstall $Kind $InstallDir $Metadata
        $phase.ownershipProved = $true
        $phase.installedFiles = @(Get-OwnedFiles $InstallDir)
        if ($installed.exitCode -ne 0) { throw "$Kind installation returned $($installed.exitCode); reboot-required codes are not accepted as a complete pass" }
        $phase.verification = Test-InstalledPayloads $InstallDir $Kind $Portable $Metadata
    } catch { $phase.error = $_.Exception.Message }
    finally {
        if ($phase.ownershipProved) {
            try {
                # Re-prove ownership immediately before any uninstall command.
                Assert-OwnedRegistration (Get-FreshnessState $Metadata) $Kind $InstallDir $Metadata
                if ($Kind -eq 'msi') {
                    $removeArgs = '/x ' + $Metadata.productCode + ' /qn /norestart /l*v "' + (Join-Path $ReportDir 'msi-uninstall.log') + '"'
                    $removed = Invoke-OwnedProcess $script:msiexec $removeArgs 'msi-uninstall'
                } else {
                    $uninstaller = Get-SafeFullPath (Join-Path $InstallDir 'uninstall.exe')
                    Assert-Below $uninstaller $script:scratch
                    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Owned NSIS uninstaller is missing' }
                    $removed = Invoke-OwnedProcess $uninstaller '/S' 'nsis-uninstall'
                }
                $phase.uninstallExitCode = $removed.exitCode
                $phase.afterUninstall = Wait-OwnedRemoval $InstallDir $Kind $Metadata
                if ($removed.exitCode -ne 0) { throw "$Kind uninstall returned $($removed.exitCode); reboot-required codes are not accepted as a complete pass" }
            } catch { $phase.cleanupError = $_.Exception.Message }
        }
    }
    if ($phase.error -or $phase.cleanupError) { throw "$Kind cycle failed: $($phase.error) $($phase.cleanupError)" }
    if (-not $phase.ownershipProved) { throw "$Kind installation ownership was not established" }
    $phase.status = 'passed'
}

try {
    if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$') { throw 'ExpectedVersion must be the exact application SemVer without a v prefix' }
    $environmentBlockers = @(Get-EnvironmentBlockers)
    $script:report.executionBlockers = $environmentBlockers
    $temporaryBase = if ($env:RUNNER_TEMP) { Get-SafeFullPath $env:RUNNER_TEMP } elseif ($DryRun) { Get-SafeFullPath ([IO.Path]::GetTempPath()) } else { throw 'RUNNER_TEMP is required' }
    $ReportDir = Get-SafeFullPath $ReportDir
    Assert-Below $ReportDir $temporaryBase
    if ((Test-Path -LiteralPath $ReportDir) -and @(Get-ChildItem -LiteralPath $ReportDir -Force).Count) { throw 'ReportDir must be empty or new; existing reports will not be overwritten' }
    [void](New-Item -ItemType Directory -Path $ReportDir -Force)
    $script:reportPath = Join-Path $ReportDir 'installer-acceptance.json'
    if (-not $DryRun -and $environmentBlockers.Count) { throw ('Refusing actual installation: ' + ($environmentBlockers -join '; ')) }
    $ArtifactDir = Get-SafeFullPath $ArtifactDir
    if (-not (Test-Path -LiteralPath $ArtifactDir -PathType Container)) { throw 'ArtifactDir must exist' }
    if ($ReportDir -ieq $ArtifactDir -or $ArtifactDir.StartsWith($ReportDir + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'ReportDir cannot contain the source artifacts' }
    $artifacts = @{}
    foreach ($spec in @(@('msi', '*.msi'), @('nsis', '*-Setup.exe'), @('portable', '*-portable.zip'))) {
        $matches = @(Get-ChildItem -LiteralPath $ArtifactDir -File | Where-Object { $_.Name -like $spec[1] })
        if ($matches.Count -ne 1) { throw "ArtifactDir must contain exactly one $($spec[1]) file" }
        $path = Get-SafeFullPath $matches[0].FullName
        $artifacts[$spec[0]] = $path
        $script:report.artifacts += [ordered]@{ kind = $spec[0]; path = $path; bytes = $matches[0].Length; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
    $metadata = Get-MsiMetadata $artifacts.msi
    $portable = Get-PortableInventory $artifacts.portable
    $script:report.msi = $metadata
    $script:report.portablePayloads = @($script:payloadNames | ForEach-Object { $portable[$_] })
    $before = Get-FreshnessState $metadata
    $script:report.before = $before
    $freshnessBlockers = @(Get-FreshnessBlockers $before)
    $script:report.executionBlockers += $freshnessBlockers
    $script:scratch = Get-SafeFullPath (Join-Path $temporaryBase ('zeroagent-installer-qa-' + [Guid]::NewGuid().ToString('N')))
    Assert-Below $script:scratch $temporaryBase
    if (Test-Path -LiteralPath $script:scratch) { throw 'Generated scratch directory already exists' }
    $msiInstall = Get-SafeFullPath (Join-Path $script:scratch 'msi-app')
    $nsisInstall = Get-SafeFullPath (Join-Path $script:scratch 'nsis-app')
    $script:msiexec = Get-SafeFullPath (Join-Path ([Environment]::GetFolderPath('System')) 'msiexec.exe')
    $script:report.scratchDirectory = $script:scratch
    $script:report.plan = @(
        [ordered]@{ operation = 'msi-install'; executable = $script:msiexec; switches = @('/i', 'owned staged MSI', '/qn', '/norestart', "INSTALLDIR=$msiInstall", '/l*v', (Join-Path $ReportDir 'msi-install.log')) },
        [ordered]@{ operation = 'verify-msi'; payloadCount = 6; companionHashMatches = 5; mainMarker = 'UNK -> MSI'; expectedProductVersion = $ExpectedVersion },
        [ordered]@{ operation = 'msi-uninstall'; executable = $script:msiexec; switches = @('/x', $metadata.productCode, '/qn', '/norestart', '/l*v', (Join-Path $ReportDir 'msi-uninstall.log')); requiresProvedOwnership = $true },
        [ordered]@{ operation = 'nsis-install'; executable = 'owned staged Setup.exe'; switches = @('/S', "/D=$nsisInstall") },
        [ordered]@{ operation = 'verify-nsis'; payloadCount = 6; companionHashMatches = 5; mainMarker = 'UNK -> NSS'; expectedProductVersion = $ExpectedVersion },
        [ordered]@{ operation = 'nsis-uninstall'; executable = (Join-Path $nsisInstall 'uninstall.exe'); switches = @('/S'); requiresProvedOwnership = $true; waitFor = 'process tree, files, uninstall registry and MSI product state'; allowedResidue = 'Only an HKCU usa0/ZeroAgent install-directory preference pointing to this exact owned GUID directory; never delete user data' }
    )
    if ($DryRun) {
        $script:report.status = 'dry-run'
        $script:report.executionAllowed = $false
    } else {
        if ($freshnessBlockers.Count) { throw ('Refusing non-fresh runner: ' + ($freshnessBlockers -join '; ')) }
        [void](New-Item -ItemType Directory -Path $script:scratch)
        $stagedMsi = Join-Path $script:scratch 'ZeroAgent.msi'
        $stagedNsis = Join-Path $script:scratch 'ZeroAgent-Setup.exe'
        Copy-Item -LiteralPath $artifacts.msi -Destination $stagedMsi
        Copy-Item -LiteralPath $artifacts.nsis -Destination $stagedNsis
        foreach ($item in @(@($artifacts.msi, $stagedMsi), @($artifacts.nsis, $stagedNsis))) {
            if ((Get-FileHash -LiteralPath $item[0] -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $item[1] -Algorithm SHA256).Hash) { throw 'Staged installer bytes changed' }
        }
        Invoke-InstallerCycle 'msi' $stagedMsi $msiInstall $metadata $portable
        Invoke-InstallerCycle 'nsis' $stagedNsis $nsisInstall $metadata $portable
        $script:report.after = Get-FreshnessState $metadata
        $script:report.status = 'passed'
    }
} catch {
    $script:report.error = $_.Exception.Message
    Write-Warning $script:report.error
} finally {
    $script:report.completedAtUtc = [DateTime]::UtcNow.ToString('o')
    if ($script:reportPath) { $script:report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $script:reportPath -Encoding UTF8 }
}
Write-Output ($script:report | ConvertTo-Json -Depth 20 -Compress)
if ($script:report.status -eq 'failed') { exit 1 }
