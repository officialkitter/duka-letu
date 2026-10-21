<#
  Builds the debug APK on Windows from a short path.

  Why: Ninja/CMake (native modules such as react-native-safe-area-context) exceed the
  260-char Windows path limit when the project lives in a deep folder, e.g.
  H:\duka-letu\apps\mobile. This script mirrors the app to a short directory, builds
  there and copies the APK back. Alternatively enable Windows long paths (admin, one
  time) or move the repo to a short path such as C:\dl and run `npx expo run:android`.

  Usage (from apps\mobile):  powershell -File scripts\build-android-win.ps1 [-Install]
#>
param(
  [string]$WorkDir = 'C:\m',
  [switch]$Install
)
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot

New-Item -ItemType Directory -Force $WorkDir | Out-Null
robocopy $src $WorkDir /MIR /XD node_modules android .expo .cxx build scripts /XF *.log /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Push-Location $WorkDir
try {
  # The workspace link back to the repo root is not needed to build the app.
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $pkg.dependencies.PSObject.Properties.Remove('duka-letu')
  [IO.File]::WriteAllText("$WorkDir\package.json", ($pkg | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding $false))
  # Without the repo root next to it the lockfile's link entry cannot resolve, so install fresh.
  Remove-Item package-lock.json -ErrorAction SilentlyContinue
  npm install --no-audit --no-fund
  if ($LASTEXITCODE) { throw 'npm install failed' }

  npx expo prebuild --clean --platform android --no-install
  if ($LASTEXITCODE) { throw 'expo prebuild failed' }

  Push-Location android
  .\gradlew.bat app:assembleDebug -x lint -x test --build-cache "-PreactNativeArchitectures=arm64-v8a"
  if ($LASTEXITCODE) { throw 'gradle build failed' }
  Pop-Location

  $apk = Join-Path $WorkDir 'android\app\build\outputs\apk\debug\app-debug.apk'
  $dest = Join-Path $src 'android\app\build\outputs\apk\debug'
  New-Item -ItemType Directory -Force $dest | Out-Null
  Copy-Item $apk $dest -Force
  Write-Host "BUILD SUCCESSFUL -> $dest\app-debug.apk"

  if ($Install) {
    adb install -r $apk
    adb shell monkey -p com.dukaletu.pos -c android.intent.category.LAUNCHER 1
  }
} finally {
  Pop-Location
}
