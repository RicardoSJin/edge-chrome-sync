$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
node --test tests/*.test.js
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path 'icons' | Out-Null
foreach ($size in @(16,32,48,128)) {
  $bitmap = New-Object System.Drawing.Bitmap($size,$size)
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(20,110,100))
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White,($size * 0.075))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawLine($pen,($size*.23),($size*.36),($size*.77),($size*.36))
  $g.DrawLine($pen,($size*.62),($size*.22),($size*.77),($size*.36))
  $g.DrawLine($pen,($size*.62),($size*.50),($size*.77),($size*.36))
  $g.DrawLine($pen,($size*.23),($size*.64),($size*.77),($size*.64))
  $g.DrawLine($pen,($size*.23),($size*.64),($size*.38),($size*.50))
  $g.DrawLine($pen,($size*.23),($size*.64),($size*.38),($size*.78))
  $bitmap.Save((Join-Path $PSScriptRoot "icons/$size.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  $pen.Dispose(); $g.Dispose(); $bitmap.Dispose()
}
$files = @('manifest.json','background.js','browser.js','core.js','dav.js','options.html','options.css','options.js','icons','README.md','PRIVACY.md','LICENSE')
$manifest = Get-Content -LiteralPath 'manifest.json' -Raw | ConvertFrom-Json
foreach ($path in @($manifest.background.service_worker,$manifest.options_page) + @($manifest.icons.PSObject.Properties.Value)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing asset: $path" }
}
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'dist') | Out-Null
$destination = Join-Path $PSScriptRoot "dist/edge-chrome-sync-v$($manifest.version).zip"
Compress-Archive -Path $files -DestinationPath $destination -Force
Write-Output "Package: $destination"
