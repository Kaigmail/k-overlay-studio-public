param([string]$RendererPath)
$ErrorActionPreference = 'Stop'
$sdkVersion = '1.0.4314.35'
$sdkSha256 = '90778DEB1B77E36292828B4B5833C9255C27533F40E0DDD55891AE718944EDC4'
$appRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$framework = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' Release
if ($framework -lt 394802 -or !(Test-Path -LiteralPath $compiler)) {
    throw 'Building the desktop app requires the x64 .NET Framework 4.6.2 or later and its C# compiler.'
}
if (!(Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\vite\bin\vite.js'))) {
    throw 'Install the editing workspace dependencies before building the desktop app.'
}
$obj = Join-Path $PSScriptRoot 'obj'
$bin = Join-Path $PSScriptRoot 'bin'
if ($RendererPath) {
    $renderer = Get-Item -LiteralPath $RendererPath
    if ($renderer.PSIsContainer -or $renderer.Extension -ne '.exe') { throw 'RendererPath must point to a browser executable.' }
}
$null = New-Item -ItemType Directory -Force $obj, $bin
$package = Join-Path $obj "webview2-$sdkVersion.nupkg"
function Get-PackageHash {
    $stream = [IO.File]::OpenRead($package)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
if (!(Test-Path -LiteralPath $package) -or (Get-PackageHash) -ne $sdkSha256) {
    $uri = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$sdkVersion/microsoft.web.webview2.$sdkVersion.nupkg"
    & curl.exe --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 180 --output $package $uri
    if ($LASTEXITCODE -ne 0) { throw 'Could not download the pinned Microsoft WebView2 SDK.' }
}
if ((Get-PackageHash) -ne $sdkSha256) { throw 'WebView2 SDK SHA-256 does not match.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem, System.Drawing
$dlls = @(
    'lib/net462/Microsoft.Web.WebView2.Core.dll'
    'lib/net462/Microsoft.Web.WebView2.WinForms.dll'
    'runtimes/win-x64/native/WebView2Loader.dll'
)
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    foreach ($name in $dlls) {
        $entry = $archive.GetEntry($name)
        if (!$entry -or !$entry.Length) { throw "Missing SDK file: $name" }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $obj ([IO.Path]::GetFileName($name))), $true)
    }
} finally { $archive.Dispose() }

# Draw a small project icon and embed its PNG as a Windows icon resource.
$bitmap = New-Object Drawing.Bitmap 64, 64
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = 'AntiAlias'
$background = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(24, 28, 41))
$stroke = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(140, 184, 255)), 5
$letter = New-Object Drawing.Pen ([Drawing.Color]::White), 5
$png = New-Object IO.MemoryStream
try {
    $graphics.FillRectangle($background, 0, 0, 64, 64)
    $graphics.DrawRectangle($stroke, 12, 10, 39, 43)
    $graphics.DrawLine($letter, 24, 20, 24, 43)
    $graphics.DrawLine($letter, 24, 33, 39, 20)
    $graphics.DrawLine($letter, 27, 31, 40, 43)
    $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
    $iconPath = Join-Path $obj 'app.ico'
    $writer = New-Object IO.BinaryWriter ([IO.File]::Create($iconPath))
    try {
        $writer.Write([byte[]](0,0,1,0,1,0,64,64,0,0,1,0,32,0))
        $writer.Write([int]$png.Length)
        $writer.Write([int]22)
        $writer.Write($png.ToArray())
    } finally { $writer.Dispose() }
} finally {
    $png.Dispose()
    $letter.Dispose()
    $stroke.Dispose()
    $background.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
}

$exe = 'K-Overlay-Studio.exe'
$references = $dlls[0..1] | ForEach-Object { '/reference:' + (Join-Path $obj ([IO.Path]::GetFileName($_))) }
$sources = Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | ForEach-Object FullName
$compilerArgs = @(
    '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001'
    "/out:$(Join-Path $obj $exe)", "/win32icon:$iconPath"
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Net.Http.dll'
    '/reference:System.Web.Extensions.dll'
) + $references + $sources
& $compiler @compilerArgs
if ($LASTEXITCODE -ne 0) { throw 'The desktop application failed to compile.' }
foreach ($name in $dlls) {
    Copy-Item -LiteralPath (Join-Path $obj ([IO.Path]::GetFileName($name))) -Destination $bin -Force
}
Copy-Item -LiteralPath (Join-Path $obj $exe) -Destination $bin -Force
if ($RendererPath) {
    [IO.File]::WriteAllText((Join-Path $bin 'renderer-path.txt'), $renderer.FullName, (New-Object Text.UTF8Encoding $false))
}
Write-Output (Join-Path $bin $exe)
