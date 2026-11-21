# 仅停止当前工作台目录中占用 5177 的 Vite 进程。
$ErrorActionPreference = 'Stop'
$port = 5177
$vite = Join-Path $PSScriptRoot 'node_modules\vite\bin\vite.js'
$listeners = @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $port)

if (!$listeners) {
    Write-Host 'K-Overlay-Studio 未在 5177 端口运行。'
    exit 0
}

$processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($processId in $processIds) {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    # npm 的 Windows 启动命令可能经 node_modules\.bin\.. 指向 Vite。
    $vitePaths = foreach ($argument in [regex]::Matches([string]$processInfo.CommandLine, '"[^"]*"|\S+')) {
        $argumentPath = $argument.Value.Trim('"')
        if ($argumentPath -match '^[A-Z]:[\\/].*[\\/]vite[\\/]bin[\\/]vite\.js$') {
            [IO.Path]::GetFullPath($argumentPath)
        }
    }
    if ($processInfo.Name -ne 'node.exe' -or $vitePaths -notcontains $vite) {
        Write-Host '5177 端口由其他程序或另一份工作台占用，未停止。' -ForegroundColor Yellow
        exit 1
    }
}

Stop-Process -Id $processIds
Write-Host 'K-Overlay-Studio 已停止。' -ForegroundColor Green
