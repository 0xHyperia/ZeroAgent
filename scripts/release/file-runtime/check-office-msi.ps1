#requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$Archive)

$ErrorActionPreference = 'Stop'
$archivePath = [IO.Path]::GetFullPath($Archive)
if ([IO.Path]::GetExtension($archivePath) -ine '.msi' -or $archivePath -match 'licensee') {
    throw 'Unexpected or protected installer path'
}

function Assert-PublicNames($Database, [string]$Query) {
    $view = $Database.OpenView($Query)
    try {
        [void]$view.Execute()
        $count = 0
        while ($record = $view.Fetch()) {
            try {
                $count++
                if ($count -gt 50000) { throw 'Installer metadata exceeds its row limit' }
                foreach ($column in 1..2) {
                    if ($record.StringData($column) -match 'licensee') {
                        throw 'A public runtime dependency contains a protected filename'
                    }
                }
            } finally {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)
            }
        }
        if ($count -eq 0) { throw 'Required installer metadata is empty' }
    } finally {
        $view.Close()
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
    }
}

$installer = New-Object -ComObject WindowsInstaller.Installer
try {
    $database = $installer.OpenDatabase($archivePath, 0) # Read-only metadata access.
    try {
        Assert-PublicNames $database 'SELECT `File`, `FileName` FROM `File`'
        Assert-PublicNames $database 'SELECT `Directory`, `DefaultDir` FROM `Directory`'
    } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
    }
} finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
}
