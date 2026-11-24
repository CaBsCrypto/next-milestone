$ErrorActionPreference = 'Stop'

$revision = 'a0fa70805f742f7da15b367770d802ea2a86c68b'
$uri = "https://raw.githubusercontent.com/moby/profiles/$revision/seccomp/default.json"
$validatorProfile = Invoke-RestMethod -Uri $uri
$validatorProfile.syscalls += [PSCustomObject]@{
    names  = @('io_uring_setup', 'io_uring_enter', 'io_uring_register')
    action = 'SCMP_ACT_ALLOW'
}

$targetDirectory = Join-Path $PSScriptRoot '../target'
New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
$output = Join-Path (Resolve-Path -LiteralPath $targetDirectory).Path 'validator-seccomp.json'
$json = $validatorProfile | ConvertTo-Json -Depth 24
[System.IO.File]::WriteAllText($output, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output $output
