# SAP GUI scripting host for sap-gui-mcp-server: the entry point.
#
# Started by the Node server (src/sapgui/host.ts) with Windows PowerShell 5.1.
# The functions are in host-lib.ps1, next to this file.

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'host-lib.ps1')
Start-Host
