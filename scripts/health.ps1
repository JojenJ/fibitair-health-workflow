param(
  [Parameter(Mandatory=$true)][string]$Url,
  [ValidateSet('status','export','sync','context')][string]$Action='status',
  [string]$Start, [string]$End, [string]$ContextFile,
  [string]$Proxy
)
$ErrorActionPreference='Stop'
$requestOptions = @{}
if (-not $Proxy -and (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings')) {
  $internetSettings = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
  if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer -match '^[a-zA-Z0-9.\-]+:\d+$') {
    $Proxy = 'http://' + $internetSettings.ProxyServer
  }
}
if ($Proxy) { $requestOptions.Proxy = $Proxy }
$tokenPath = Join-Path $PSScriptRoot '../secrets/ADMIN_TOKEN.txt'
$headers = @{ Authorization = 'Bearer ' + (Get-Content -LiteralPath $tokenPath -Raw).Trim() }
$base = $Url.TrimEnd('/')
if ($Action -eq 'context') {
  if (-not $ContextFile) { throw 'ContextFile required' }
  $result = Invoke-RestMethod @requestOptions -Uri "$base/context" -Method Put -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes((Get-Content -LiteralPath $ContextFile -Raw)))
} elseif ($Action -eq 'sync') {
  $body = @{start=$Start;end=$End} | ConvertTo-Json
  $result = Invoke-RestMethod @requestOptions -Uri "$base/sync" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
} elseif ($Action -eq 'export') {
  $query = if ($Start -and $End) { '?start='+[uri]::EscapeDataString($Start)+'&end='+[uri]::EscapeDataString($End) } else { '' }
  $result = Invoke-RestMethod @requestOptions -Uri "$base/export$query" -Headers $headers
  $folder = Join-Path $PSScriptRoot '../exports'
  New-Item -ItemType Directory -Force -Path $folder | Out-Null
  $target = Join-Path $folder ('health-'+(Get-Date -Format 'yyyyMMdd-HHmmss')+'.json')
  $result | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $target -Encoding utf8
  Write-Output "Saved $target"; exit
} else { $result = Invoke-RestMethod @requestOptions -Uri "$base/status" -Headers $headers }
$result | ConvertTo-Json -Depth 10
