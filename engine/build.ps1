# DRE(PC 프로그램) 빌드 — 윈도우에 기본으로 있는 .NET Framework 4 컴파일러(csc.exe)만 쓴다.
# web 폴더(앱 화면)를 app.zip 으로 묶어 실행 파일 안에 넣는다 → 설치하면 인터넷 없이 PC 안에서 앱이 열린다.
# 순서: (앱을 고쳤으면) python ..\..\web-tests\tools\stamp.py → 이 스크립트 → DRE.exe --install --quiet
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$web = Split-Path -Parent $here
$zip = Join-Path $env:TEMP 'dre-app.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }

# 앱 파일 묶기(개발용 _dev, PC 프로그램 소스, 설명 문서는 빼고). 이름은 '/' 로(브라우저 경로와 같게)
$skipDirs = @('_dev', 'engine', '.git', 'node_modules')
$fs = [System.IO.File]::Open($zip, 'Create')
$za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
$count = 0
Get-ChildItem -Path $web -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($web.Length + 1)
  $top = $rel.Split('\')[0]
  if ($skipDirs -contains $top) { return }
  if ($_.Name -like '*.md' -or $_.Name -eq '.gitignore') { return }
  $entryName = $rel.Replace('\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $_.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  $count++
}
$za.Dispose(); $fs.Dispose()
Write-Host "앱 파일 $count 개 묶음: $([math]::Round((Get-Item $zip).Length / 1MB, 2))MB"

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$out = Join-Path $here 'DRE.exe'
& $csc /nologo /target:winexe /platform:anycpu /optimize+ /codepage:65001 `
  "/win32icon:$(Join-Path $here 'dre.ico')" "/out:$out" "/resource:$zip,app.zip" `
  /r:System.dll /r:System.Core.dll /r:Microsoft.CSharp.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll `
  (Join-Path $here 'DRE.cs')
if ($LASTEXITCODE -ne 0) { throw "빌드 실패" }
Remove-Item $zip -Force
Get-Item $out | Select-Object Name, Length, LastWriteTime
