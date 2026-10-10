param(
    [Parameter(Mandatory)][string]$FilesJson,
    [Parameter(Mandatory)][string]$Root,
    [string]$Evidence,
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$files = @(Get-Content -Raw -LiteralPath $FilesJson | ConvertFrom-Json)
if ($files.Count -eq 0) { throw 'No files supplied for signing' }
Import-Module ArtifactSigning -RequiredVersion 0.1.8
if (-not $VerifyOnly) {
    # Use only the Azure CLI session established by the OIDC login action.
    Invoke-ArtifactSigning -Endpoint $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
        -CodeSigningAccountName $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
        -CertificateProfileName $env:AZURE_ARTIFACT_SIGNING_PROFILE `
        -Files ($files -join ',') -FileDigest SHA256 `
        -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256 `
        -ExcludeEnvironmentCredential:$true -ExcludeWorkloadIdentityCredential:$true `
        -ExcludeManagedIdentityCredential:$true -ExcludeSharedTokenCacheCredential:$true `
        -ExcludeVisualStudioCredential:$true -ExcludeVisualStudioCodeCredential:$true `
        -ExcludeAzurePowerShellCredential:$true -ExcludeAzureDeveloperCliCredential:$true `
        -ExcludeInteractiveBrowserCredential:$true
}
# ArtifactSigning 0.1.8 uses the same SDK/client pins as the official v2 action.
$sdk = Join-Path $env:LOCALAPPDATA 'ArtifactSigning/Microsoft.Windows.SDK.BuildTools/Microsoft.Windows.SDK.BuildTools.10.0.26100.4188'
$tools = @(Get-ChildItem -LiteralPath $sdk -Recurse -Filter signtool.exe | Where-Object { $_.Directory.Name -eq 'x64' })
if ($tools.Count -ne 1) { throw 'Pinned x64 SignTool was not installed' }
$proof = [ordered]@{}
foreach ($file in $files) {
    & $tools[0].FullName verify /pa /all /tw $file
    if ($LASTEXITCODE -ne 0) { throw "SignTool verification failed: $file" }
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate) {
        throw "A valid timestamped Authenticode signature is required: $file"
    }
    $relative = [IO.Path]::GetRelativePath($Root, $file).Replace('\', '/')
    $proof[$relative] = @{
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        verified = 'signtool /pa /all /tw'
        timestamp = $signature.TimeStamperCertificate.Thumbprint
    }
}
if (-not $VerifyOnly) {
    @{ schema = 1; files = $proof } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Evidence -Encoding utf8
}
