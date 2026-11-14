# Test only: the PowerShell host with a fake SAP GUI in place of the real one.
#
# It dot-sources the shipped functions (src/sapgui/ps/host-lib.ps1) and
# replaces the one function that fetches SAP GUI's scripting object, so that
# every other line under test is the shipped code. The fake is the script
# component next to this file (fake-sapgui.wsc), which serves
# fixtures/world.json. This file is not part of the published package.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\sapgui\fake-host.ps1
#
# SAPGUI_MCP_FAKE_WORLD may name another world file (default: fixtures\world.json).

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\..\src\sapgui\ps\host-lib.ps1')

if (-not $env:SAPGUI_MCP_FAKE_WORLD) { $env:SAPGUI_MCP_FAKE_WORLD = Join-Path $PSScriptRoot 'fixtures\world.json' }
$script:fake = $null

function Get-SapGui {
  if ($null -eq $script:fake) {
    $script:fake = [System.Runtime.InteropServices.Marshal]::BindToMoniker('script:' + (Join-Path $PSScriptRoot 'fake-sapgui.wsc'))
  }
  , $script:fake
}

Start-Host
