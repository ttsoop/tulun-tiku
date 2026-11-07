# 构建油猴脚本（在无空格路径的临时目录里构建，然后拷回 dist）
# 用法：pwsh -File tools/bank-builder/build-userscript.ps1
$ErrorActionPreference = 'Stop'
$ws = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# 用带完整 node_modules 副本的构建目录（node_modules 里是指向 packages/* 的链接，不能用联接代替）
$bd = 'C:\Users\dell\AppData\Local\Temp\dsh-g1Yopy\ocsjs-build'
if (-not (Test-Path $bd)) { $bd = Join-Path $env:TEMP 'ocsjs-build' }
if (-not (Test-Path $bd)) { New-Item -ItemType Directory -Path $bd -Force | Out-Null }
# 依赖不复制（太慢），用目录联接指回工作区的 node_modules
if (-not (Test-Path (Join-Path $bd 'node_modules'))) {
    New-Item -ItemType Junction -Path (Join-Path $bd 'node_modules') -Target (Join-Path $ws 'node_modules') | Out-Null
}

Write-Host "[1/4] 同步源码 -> $bd"
$null = robocopy $ws $bd /E /XD '.git' 'node_modules' 'dist' 'lib' '.pnpm-store' '.npm-cache' '.pnpm' '.tmp-test' '图论章节题库' '题库' 'tools' /XF '.DS_Store' /NFL /NDL /NJH /NJS
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败: $LASTEXITCODE" }

$tsc = Join-Path $bd 'node_modules\typescript\bin\tsc'
foreach ($pkg in 'utils', 'core') {
    $dir = Join-Path $bd "packages\$pkg"
    Push-Location $dir
    Write-Host "[2/4] tsc packages/$pkg"
    & node $tsc
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) { throw "tsc packages/$pkg 失败: $code" }
}

Push-Location $bd
Write-Host '[3/4] gulp build-core'
# vite.config 用 VITE_BUILD_PATH 决定产物目录（不设会报 paths[1] undefined）
$env:VITE_BUILD_PATH = '../../dist'
# build-core 会调用 tsx 跑 resolver 测试，需要把本地 bin 加进 PATH
$env:PATH = (Join-Path $bd 'node_modules\.bin') + ';' + $env:PATH
& node 'node_modules\gulp-cli\bin\gulp.js' -f '.\scripts\build-core.js'
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "build-core 失败: $code" }

Write-Host '[4/4] 拷贝产物 -> dist'
Copy-Item (Join-Path $bd 'dist\*') -Destination (Join-Path $ws 'dist') -Force
$file = Join-Path $ws 'dist\ocs.user.js'
$size = [math]::Round((Get-Item $file).Length / 1KB, 1)
Write-Host "完成: dist/ocs.user.js  $size KB"




