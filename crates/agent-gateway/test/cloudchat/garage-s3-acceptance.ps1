[CmdletBinding()]
param()

# Opt-in disposable local real-service acceptance; never used by production.
# No image pull, system install, existing-resource mutation, or external S3 use.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$gatewayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $gatewayRoot '..\..'))
$taskID = [Guid]::NewGuid().ToString('N').Substring(0, 16)
$taskLabel = 'com.zeroagent.cloudchat-s3-test'
$resourcePrefix = "za-garage-$taskID"
$containerName = "$resourcePrefix-server"
$helperName = "$resourcePrefix-volume-init"
$runnerName = "$resourcePrefix-client"
$networkName = "$resourcePrefix-network"
$volumeName = "$resourcePrefix-data"
$bucketName = "za-garage-test-$taskID"
$evidenceDir = [IO.Path]::GetFullPath((Join-Path $workspaceRoot ".codex-artifacts\garage-s3-$taskID"))
$requiredDigest = 'dxflrs/garage@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5'
$privatePaths = [Collections.Generic.List[string]]::new()
$taskSecrets = [Collections.Generic.List[string]]::new()
$previousEnv = @{}
$envNames = @('ZEROAGENT_GARAGE_TEST_CONFIG_FILE', 'ZEROAGENT_GARAGE_TEST_PHASE', 'ZEROAGENT_GARAGE_TEST_EVIDENCE_FILE','GOOS','GOARCH','CGO_ENABLED')
$testBinaryPath = Join-Path $evidenceDir 'garage-client-linux-amd64.test'
$privateConfigPath = Join-Path $evidenceDir 'connection.private.json'
$initImageID = ''
$report = [ordered]@{ task_id = $taskID; official_quick_start = 'https://garagehq.deuxfleurs.fr/documentation/quick-start/'; official_image = $requiredDigest; synthetic_only = $true; paid_services_used = $false; passed = $false; cleanup = @{} }

function Invoke-TaskDocker {
    param([string[]]$DockerArgs)
    $result = & docker @DockerArgs 2>&1
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "Docker operation $($DockerArgs[0]) failed (exit=$code); no credentials were printed." }
    return $result
}

function Write-TaskPrivateFile {
    param([string]$Path, [string]$Content)
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($evidenceDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Private path escaped task directory.' }
    [IO.File]::WriteAllText($resolved, $Content, [Text.UTF8Encoding]::new($false))
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
    Set-Acl -LiteralPath $resolved -AclObject $acl
    $privatePaths.Add($resolved)
}

function Remove-TaskDockerResource {
    param([string]$Kind, [string]$Name)
    $template = if ($Kind -eq 'container') { '{{ index .Config.Labels "com.zeroagent.cloudchat-s3-test" }}' } else { '{{ index .Labels "com.zeroagent.cloudchat-s3-test" }}' }
    $label = @(& docker $Kind inspect $Name --format $template 2>$null)
    if ($LASTEXITCODE -ne 0) { $report.cleanup[$Name] = 'absent'; return }
    if ([string]::Join('', [string[]]$label).Trim() -ne $taskID) { throw "Refusing cleanup: task label mismatch for $Kind $Name." }
    if ($Kind -eq 'container') { $null = Invoke-TaskDocker @('container', 'rm', '--force', $Name) }
    else { $null = Invoke-TaskDocker @($Kind, 'rm', $Name) }
    $report.cleanup[$Name] = 'removed_after_label_check'
}

function Run-TaskGaragePhase {
    param([string]$Phase)
    # Docker's internal network deliberately exposes no host ports. Run the
    # actual statically compiled Go client in the server's private netns.
    $runnerArgs=@('run','--rm','--pull','never','--name',$runnerName,'--label',"$taskLabel=$taskID",'--network',"container:$containerName",'--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64','--memory','512m','--cpus','1','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=128m,uid=10001,gid=10001,mode=0700','--mount',"type=bind,source=$testBinaryPath,target=/tests/garage.test,readonly",'--mount',"type=bind,source=$privateConfigPath,target=/run/connection.private.json,readonly",'--mount',"type=bind,source=$evidenceDir,target=/evidence",'--env','ZEROAGENT_GARAGE_TEST_CONFIG_FILE=/run/connection.private.json','--env',"ZEROAGENT_GARAGE_TEST_PHASE=$Phase",'--env',"ZEROAGENT_GARAGE_TEST_EVIDENCE_FILE=/evidence/$Phase.json",'--entrypoint','/tests/garage.test',$initImageID,'-test.run=^TestGarageS3Compatibility$','-test.count=1','-test.v','-test.timeout=4m')
    $testOutput = @(& docker @runnerArgs 2>&1)
    $testCode = $LASTEXITCODE
    $safeOutput = [string]::Join([Environment]::NewLine, [string[]]$testOutput)
    foreach ($secret in $taskSecrets) { $safeOutput = $safeOutput.Replace($secret, '[redacted]') }
    [IO.File]::WriteAllText((Join-Path $evidenceDir "$Phase.test.log"), $safeOutput + [Environment]::NewLine)
    Write-Output $safeOutput
    if ($testCode -ne 0) { throw "Real Garage acceptance phase $Phase failed (exit=$testCode)." }
}

$originalLocation = Get-Location
try {
    foreach ($name in $envNames) { $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    $null = New-Item -ItemType Directory -Path $evidenceDir
    $report.started_at = [DateTimeOffset]::UtcNow.ToString('o')
    $images = Invoke-TaskDocker @('image', 'inspect', 'dxflrs/garage:v2.5.0', '--format', '{{json .RepoDigests}}')
    if (-not (([string]::Join('', $images) | ConvertFrom-Json) -contains $requiredDigest)) { throw 'Official Garage image digest differs; review before running.' }
    $garageImageID = [string]::Join('', (Invoke-TaskDocker @('image', 'inspect', $requiredDigest, '--format', '{{.Id}}'))).Trim()
    $initImageID = [string]::Join('', (Invoke-TaskDocker @('image', 'inspect', 'zeroagent-cloud-executor:cloudchat-local', '--format', '{{.Id}}'))).Trim()
    $report.garage_image_id = $garageImageID
    $report.volume_init_image_id = $initImageID
    $report.version = [string]::Join('', (Invoke-TaskDocker @('run', '--rm', '--network', 'none', '--entrypoint', '/garage', $requiredDigest, '--version'))).Trim()
    Set-Location -LiteralPath $gatewayRoot
    $env:GOOS='linux'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
    $compileOutput=@(& go test -c ./test/cloudchat -o $testBinaryPath 2>&1)
    $compileCode=$LASTEXITCODE
    [IO.File]::WriteAllText((Join-Path $evidenceDir 'client-build.log'),[string]::Join([Environment]::NewLine,[string[]]$compileOutput))
    if($compileCode -ne 0) {throw 'Compile isolated Linux S3 client failed.'}
    $report.client_binary_sha256=(Get-FileHash -LiteralPath $testBinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $accessKey = 'GK' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLowerInvariant()
    $secretKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    $rpcSecret = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
    foreach ($secret in @($accessKey, $secretKey, $rpcSecret)) { $taskSecrets.Add($secret) }
    $configPath = Join-Path $evidenceDir 'garage.private.toml'
    $envPath = Join-Path $evidenceDir 'garage.private.env'
    $garageConfig = @"
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"
replication_factor = 1
rpc_bind_addr = "0.0.0.0:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "$rpcSecret"

[s3_api]
s3_region = "garage"
api_bind_addr = "0.0.0.0:3900"
root_domain = ".s3.garage.invalid"
"@
    Write-TaskPrivateFile $configPath $garageConfig
    Write-TaskPrivateFile $envPath "GARAGE_DEFAULT_ACCESS_KEY=$accessKey`nGARAGE_DEFAULT_SECRET_KEY=$secretKey`nGARAGE_DEFAULT_BUCKET=$bucketName`nRUST_LOG=warn`n"
    $null = Invoke-TaskDocker @('network', 'create', '--internal', '--label', "$taskLabel=$taskID", $networkName)
    $null = Invoke-TaskDocker @('volume', 'create', '--label', "$taskLabel=$taskID", $volumeName)
    $initJS = 'const fs=require("node:fs");const ps=["/garage-data/meta","/garage-data/data","/garage-data"];for(const p of ps)fs.mkdirSync(p,{recursive:true});for(const p of ps){fs.chmodSync(p,0o700);fs.chownSync(p,10001,10001)}'
    $null = Invoke-TaskDocker @('run', '--rm', '--name', $helperName, '--label', "$taskLabel=$taskID", '--network', 'none', '--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges', '--entrypoint', 'node', '--mount', "type=volume,source=$volumeName,target=/garage-data", $initImageID, '-e', $initJS)
    $null = Invoke-TaskDocker @('create', '--name', $containerName, '--label', "$taskLabel=$taskID", '--network', $networkName, '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '256', '--memory', '768m', '--cpus', '1', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--mount', "type=volume,source=$volumeName,target=/var/lib/garage", '--mount', "type=bind,source=$configPath,target=/etc/garage.toml,readonly", '--env-file', $envPath, '--entrypoint', '/garage', $requiredDigest, 'server', '--single-node', '--default-bucket')
    $null = Invoke-TaskDocker @('start', $containerName)
    $portsJSON=[string]::Join('',[string[]](Invoke-TaskDocker @('container','inspect',$containerName,'--format','{{json .NetworkSettings.Ports}}'))).Trim()
    if($portsJSON -notin @('{}','null')) {throw 'Garage unexpectedly publishes host ports.'}
    $endpoint = 'http://127.0.0.1:3900'
    $privateConfig = @{ Endpoint=$endpoint; Bucket=$bucketName; Region='garage'; AccessKeyID=$accessKey; SecretAccessKey=$secretKey; TaskID=$taskID } | ConvertTo-Json
    Write-TaskPrivateFile $privateConfigPath $privateConfig
    $env:ZEROAGENT_GARAGE_TEST_CONFIG_FILE = $privateConfigPath
    $report.endpoint = $endpoint
    $report.runtime_user = '10001:10001'
    $report.internal_network = [string]::Join('', (Invoke-TaskDocker @('network', 'inspect', $networkName, '--format', '{{.Internal}}'))).Trim() -eq 'true'
    if (-not $report.internal_network) { throw 'Task network is not internal.' }
    $report.published_ports = @{}
    $report.client_network_mode='container:server-private-netns'
    $report.first_started_at = [string]::Join('', (Invoke-TaskDocker @('container', 'inspect', $containerName, '--format', '{{.State.StartedAt}}'))).Trim()
    Set-Location -LiteralPath $gatewayRoot
    Run-TaskGaragePhase 'prepare'
    $null = Invoke-TaskDocker @('restart', '--time', '10', $containerName)
    $report.restarted_at = [string]::Join('', (Invoke-TaskDocker @('container', 'inspect', $containerName, '--format', '{{.State.StartedAt}}'))).Trim()
    if ($report.first_started_at -eq $report.restarted_at) { throw 'Container did not actually restart.' }
    Run-TaskGaragePhase 'verify'
    $report.passed = $true
} finally {
    Set-Location -LiteralPath $originalLocation
    # Logs can mention bootstrap keys. Only a redacted copy enters evidence.
    $logs = @(& docker logs $containerName 2>&1)
    if ($LASTEXITCODE -eq 0) {
        $safeLogs = [string]::Join([Environment]::NewLine, [string[]]$logs)
        foreach ($secret in $taskSecrets) { $safeLogs = $safeLogs.Replace($secret, '[redacted]') }
        [IO.File]::WriteAllText((Join-Path $evidenceDir 'garage.redacted.log'), $safeLogs + [Environment]::NewLine)
    }
    foreach ($name in $envNames) { [Environment]::SetEnvironmentVariable($name, $previousEnv[$name], 'Process') }
    $cleanupErrors=[Collections.Generic.List[string]]::new()
    foreach ($resource in @(@('container',$runnerName),@('container',$containerName), @('container',$helperName), @('network',$networkName), @('volume',$volumeName))) {
        try {Remove-TaskDockerResource $resource[0] $resource[1]} catch {$cleanupErrors.Add("$($resource[0]):$($resource[1])")}
    }
    foreach ($privatePath in $privatePaths) {
        $resolved = [IO.Path]::GetFullPath($privatePath)
        if (-not $resolved.StartsWith($evidenceDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing private-file cleanup outside task directory.' }
        # Preserve the task record while retiring synthetic credentials; no
        # deletion or user-data cleanup is required for this test workflow.
        [IO.File]::WriteAllText($resolved,"# Retired disposable local test configuration.`n",[Text.UTF8Encoding]::new($false))
    }
    $report.cleanup_errors=@($cleanupErrors)
    if($cleanupErrors.Count -gt 0) {$report.passed=$false}
    $report.finished_at = [DateTimeOffset]::UtcNow.ToString('o')
    $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidenceDir 'provenance.json') -Encoding utf8NoBOM
    Write-Output "Garage evidence: $evidenceDir"
    if($cleanupErrors.Count -gt 0) {throw 'Task resource cleanup requires review; evidence retained.'}
}
