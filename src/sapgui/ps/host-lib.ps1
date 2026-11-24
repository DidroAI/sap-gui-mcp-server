# SAP GUI scripting host for sap-ui-automation: the functions.
#
# host.ps1 dot-sources this file and calls Start-Host. One long-lived Windows
# PowerShell 5.1 process, started by the Node server. It attaches to the SAP GUI the user already has open (it never logs on) and
# answers requests, one JSON object per line on stdin, one per line on stdout:
#
#   {"id":1,"op":"sessions"}                         -> {"id":1,"ok":true,"result":{...}}
#   {"id":2,"op":"screen","session":"/app/con[0]/ses[0]"}
#   {"id":3,"op":"act","session":"...","action":{"do":"press","id":"wnd[0]/tbar[0]/btn[3]"}}
#   {"id":4,"op":"describe","session":"...","control":"wnd[0]/mbar/menu[0]/menu[1]"}
#   on failure                                       -> {"id":3,"ok":false,"error":"CODE: text"}
#
# Ops: ping, sessions, info, screen, describe, act, screenshot, doctor-local, doctor-engine.
# Act kinds beyond SAP GUI's own verbs: selectrow (a table control's row, by its absolute number),
# cell (an ALV grid cell: modifyCell, then triggerModified).
# An act answers {done:true}; a scroll adds where the control was and is (from, first, visible, total).
# The host returns raw facts (ids, types, texts, state, grids, trees); the text
# view is formatted in TypeScript (src/sapgui/format.ts).
#
# The host reaches SAP GUI in one way only: the object named "SAPGUI" in the
# running object table (Get-SapGui). No setting or environment variable can
# point it at anything else.
#
# Every COM call is late bound through IDispatch (InvokeMember), which needs no
# type library and works on the object SAP GUI registers as "SAPGUI".

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.NewLine = "`n"
$writer.AutoFlush = $true
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName System.Web.Extensions
$parser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$parser.MaxJsonLength = [int]::MaxValue

# ---- JSON out ---------------------------------------------------------------
# Written by hand: PowerShell wraps values in PSObject, which the .NET
# serializers cannot write.

function Write-Json($v, [System.Text.StringBuilder]$sb) {
  if ($null -eq $v) { [void]$sb.Append('null'); return }
  if ($v -is [string]) { [void]$sb.Append([System.Web.HttpUtility]::JavaScriptStringEncode([string]$v, $true)); return }
  if ($v -is [bool]) { if ($v) { [void]$sb.Append('true') } else { [void]$sb.Append('false') }; return }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single] -or $v -is [int16] -or $v -is [byte]) {
    [void]$sb.Append(([System.IConvertible]$v).ToString([System.Globalization.CultureInfo]::InvariantCulture)); return
  }
  if ($v -is [System.Collections.IDictionary]) {
    [void]$sb.Append('{')
    $first = $true
    foreach ($k in $v.Keys) {
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      [void]$sb.Append([System.Web.HttpUtility]::JavaScriptStringEncode([string]$k, $true)).Append(':')
      Write-Json $v[$k] $sb
    }
    [void]$sb.Append('}')
    return
  }
  if ($v -is [System.Collections.IEnumerable]) {
    [void]$sb.Append('[')
    $first = $true
    foreach ($x in $v) {
      if (-not $first) { [void]$sb.Append(',') }
      $first = $false
      if ($x -is [string]) { [void]$sb.Append([System.Web.HttpUtility]::JavaScriptStringEncode([string]$x, $true)) }
      else { Write-Json $x $sb }
    }
    [void]$sb.Append(']')
    return
  }
  [void]$sb.Append([System.Web.HttpUtility]::JavaScriptStringEncode([string]$v, $true))
}

function New-List { , (New-Object System.Collections.ArrayList) }

# ---- COM, late bound ----------------------------------------------------------

$BF = [System.Reflection.BindingFlags]
$GET = $BF::GetProperty -bor $BF::InvokeMethod
$CALL = $BF::InvokeMethod
$PUT = $BF::SetProperty
$COM = [System.__ComObject]

# Property or method with arguments; throws when SAP GUI refuses.
# Flags as VBScript sends them, the client SAP GUI scripting is written for:
# property-or-method for a value, method for a statement.
function G($o, [string]$name, $a) {
  $r = $COM.InvokeMember($name, $GET, $null, $o, $a)
  if ($r -is [System.DBNull]) { return , $null }
  , $r
}
# The same, $null when the object has no such member or SAP GUI refuses.
function T($o, [string]$name, $a) {
  try {
    $r = $COM.InvokeMember($name, $GET, $null, $o, $a)
    if ($r -is [System.DBNull]) { return , $null }
    , $r
  } catch { , $null }
}
# Method without a result.
function M($o, [string]$name, $a) { [void]$COM.InvokeMember($name, $CALL, $null, $o, $a) }
# Property write.
function S($o, [string]$name, $v) { [void]$COM.InvokeMember($name, $PUT, $null, $o, [object[]]@(, $v)) }

function Items($coll) {
  $out = New-List
  if ($null -eq $coll) { return , $out }
  $n = [int](G $coll 'Count')
  for ($i = 0; $i -lt $n; $i++) { [void]$out.Add((G $coll 'ElementAt' @($i))) }
  , $out
}

function Strings($coll) {
  $out = New-List
  if ($null -eq $coll) { return , $out }
  $n = [int](G $coll 'Count')
  for ($i = 0; $i -lt $n; $i++) { [void]$out.Add([string](G $coll 'ElementAt' @($i))) }
  , $out
}

function Error-Text($e) {
  $x = $e.Exception
  while ($null -ne $x.InnerException) { $x = $x.InnerException }
  [string]$x.Message
}

function Sap-Processes {
  @(Get-Process -Name saplogon, saplgpad, sapgui -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.ProcessName } | Sort-Object -Unique)
}

# The object SAP GUI registers for scripting, and no other: the name is fixed.
# (The Windows tests replace this one function with a fake SAP GUI, in
# test/sapgui/fake-host.ps1; nothing in the shipped host can change it.)
#
# "SAPGUI" is the display name of an entry in the running object table, not a
# class name, so it is bound as a moniker, as VBScript's GetObject("SAPGUI")
# does (Marshal.GetActiveObject wants a registered class and answers "Invalid
# class string"). Windows resolves a moniker name in the running object table
# first, then as a file path: the working directory is moved to the Windows
# system folder first, so that a file named SAPGUI in the folder the server
# was started from can never be what gets bound.
function Get-SapGui {
  try {
    [Environment]::CurrentDirectory = [Environment]::SystemDirectory
    , [System.Runtime.InteropServices.Marshal]::BindToMoniker('SAPGUI')
  }
  catch {
    # SAP GUI registers that object only while scripting is on.
    if (@(Sap-Processes).Count -gt 0) { throw 'SCRIPTING_OFF: SAP GUI is running but does not offer scripting' }
    throw 'NO_SAPGUI: SAP GUI is not running'
  }
}

function Get-Engine {
  $rot = Get-SapGui
  $eng = T $rot 'GetScriptingEngine'
  if ($null -eq $eng) { throw 'NO_ENGINE: SAP GUI did not give its scripting engine (scripting is switched off in the SAP GUI options)' }
  , $eng
}

function Get-Session($eng, [string]$sid) {
  $s = T $eng 'FindById' @($sid, $false)
  if ($null -eq $s) { throw "NO_SESSION: session $sid is closed" }
  , $s
}

# SAP GUI answers no call while a session is busy (a long roundtrip): wait a little, then say so.
function Wait-Ready($ses) {
  for ($i = 0; $i -lt 100; $i++) {
    if (-not [bool](T $ses 'Busy')) { return }
    Start-Sleep -Milliseconds 100
  }
  throw 'BUSY: the session is still busy with its last step'
}

function Rel([string]$id) {
  if ($script:prefix -and $id.StartsWith($script:prefix)) { return $id.Substring($script:prefix.Length) }
  $id
}

# ---- sessions -------------------------------------------------------------------

function Session-Facts($ses) {
  $f = @{ id = [string](T $ses 'Id'); busy = [bool](T $ses 'Busy') }
  if ($f.busy) { return $f }
  $info = T $ses 'Info'
  if ($null -ne $info) {
    $f.system = [string](T $info 'SystemName')
    $f.client = [string](T $info 'Client')
    $f.user = [string](T $info 'User')
    $f.transaction = [string](T $info 'Transaction')
    $f.program = [string](T $info 'Program')
    $f.screen = [string](T $info 'ScreenNumber')
    $f.sessionNumber = [int](T $info 'SessionNumber')
    $f.language = [string](T $info 'Language')
  }
  $script:prefix = $f.id + '/'
  $wins = New-List
  foreach ($w in (Items (T $ses 'Children'))) {
    [void]$wins.Add(@{ id = (Rel ([string](T $w 'Id'))); title = [string](T $w 'Text') })
  }
  $f.windows = $wins
  $aw = T $ses 'ActiveWindow'
  if ($null -ne $aw) { $f.activeWindow = Rel ([string](T $aw 'Id')) }
  $f
}

function Op-Sessions {
  $eng = Get-Engine
  $active = ''
  $as = T $eng 'ActiveSession'
  if ($null -ne $as) { $active = [string](T $as 'Id') }
  $cons = New-List
  foreach ($con in (Items (T $eng 'Children'))) {
    $c = @{
      id = [string](T $con 'Id')
      description = [string](T $con 'Description')
      disabledByServer = [bool](T $con 'DisabledByServer')
    }
    $sessions = New-List
    foreach ($ses in (Items (T $con 'Children'))) { [void]$sessions.Add((Session-Facts $ses)) }
    $c.sessions = $sessions
    [void]$cons.Add($c)
  }
  @{ active = $active; connections = $cons }
}

function Op-Info($req) {
  $ses = Get-Session (Get-Engine) ([string]$req['session'])
  Session-Facts $ses
}

# ---- screen ---------------------------------------------------------------------

$SKIP = @{}
foreach ($t in 'GuiUserArea', 'GuiSimpleContainer', 'GuiScrollContainer', 'GuiCustomControl', 'GuiContainerShell',
  'GuiSplitterContainer', 'GuiDockShell', 'GuiTitlebar', 'GuiMenubar', 'GuiTabStrip', 'GuiMenu', 'GuiOkCodeField') { $SKIP[$t] = $true }

function Shown($tree, [string]$k, $seen) {
  if ($seen.ContainsKey($k)) { return $seen[$k] }
  $parent = ''
  try { $parent = [string](G $tree 'GetParent' @($k)) } catch { $parent = '' }
  $ok = $true
  if ($parent.Trim()) {
    try { $ok = [bool](G $tree 'IsFolderExpanded' @($parent)) -and (Shown $tree $parent $seen) }
    catch { $ok = Shown $tree $parent $seen }
  }
  $seen[$k] = $ok
  $ok
}

function Shell-Facts($o, $n) {
  $sub = [string](T $o 'SubType')
  $n.sub = $sub
  try {
    if ($sub -eq 'GridView') {
      $cols = Strings (G $o 'ColumnOrder')
      $titles = New-List
      foreach ($c in $cols) {
        try { [void]$titles.Add([string](G $o 'GetDisplayedColumnTitle' @($c))) } catch { [void]$titles.Add($c) }
      }
      $rc = [int](G $o 'RowCount')
      # The rows are read from the first one the grid shows: {"do":"scroll"} moves it.
      # Near the end the window moves back, so that it is as long as it can be.
      $first = 0
      $fv = T $o 'FirstVisibleRow'
      if ($null -ne $fv) { $first = [int]$fv }
      $first = [Math]::Max(0, [Math]::Min($first, $rc - $script:maxGridRows))
      $rows = New-List
      for ($r = $first; $r -lt [Math]::Min($rc, $first + $script:maxGridRows); $r++) {
        $cells = New-List
        foreach ($c in $cols) {
          try { [void]$cells.Add([string](G $o 'GetCellValue' @($r, $c))) } catch { [void]$cells.Add('') }
        }
        [void]$rows.Add($cells)
      }
      $n.grid = @{ cols = $cols; titles = $titles; rowCount = $rc; rows = $rows; first = $first }
    }
    elseif ($sub -eq 'Tree') {
      $all = Strings (G $o 'GetAllNodeKeys')
      $seen = New-Object 'System.Collections.Generic.Dictionary[string,bool]'
      $keys = New-List
      foreach ($k in $all) { if (Shown $o $k $seen) { [void]$keys.Add($k) } }
      # Column trees keep more text in item columns; simple trees have no column names.
      $colNames = $null
      try { $cn = G $o 'GetColumnNames'; if ($null -ne $cn) { $colNames = Strings $cn } } catch { $colNames = $null }
      $heads = New-List
      if ($null -ne $colNames) {
        try { foreach ($c in $colNames) { [void]$heads.Add([string](G $o 'GetColumnTitleFromName' @($c))) } } catch { }
      }
      $nodes = New-List
      $count = 0
      # A tree longer than the limit is read from the node {"do":"scroll"} asked for.
      $from = 0
      if ($null -ne $script:treeFrom -and $script:treeFrom.ContainsKey([string]$n.id)) { $from = [int]$script:treeFrom[[string]$n.id] }
      $from = [Math]::Max(0, [Math]::Min($from, $keys.Count - 1))
      $at = -1
      foreach ($k in $keys) {
        $at++
        if ($at -lt $from) { continue }
        if ($count -ge $script:maxTreeNodes) { break }
        $count++
        $nd = @{ key = $k }
        try { $nd.depth = [int](G $o 'GetHierarchyLevel' @($k)) } catch { $nd.depth = 0 }
        $nd.text = [string](G $o 'GetNodeTextByKey' @($k))
        $items = $null
        if ($null -ne $colNames) {
          try {
            $items = New-List
            foreach ($c in $colNames) { [void]$items.Add([string](G $o 'GetItemText' @($k, $c))) }
          } catch { $items = $null }
        }
        $nd.items = $items
        try {
          if ([bool](G $o 'IsFolder' @($k))) { $nd.folder = $true; $nd.expanded = [bool](G $o 'IsFolderExpanded' @($k)) }
        } catch { }
        [void]$nodes.Add($nd)
      }
      $n.tree = @{ shown = $keys.Count; headers = $heads; nodes = $nodes; first = $from }
    }
    elseif ($sub -eq 'TextEdit') {
      $n.text = [string](T $o 'Text')
    }
    elseif ($sub -eq 'Toolbar') {
      $btns = New-List
      $bc = [int](T $o 'ButtonCount')
      for ($i = 0; $i -lt $bc; $i++) {
        try {
          $bid = [string](G $o 'GetButtonId' @($i))
          $txt = [string](G $o 'GetButtonText' @($i))
          $tip = [string](G $o 'GetButtonTooltip' @($i))
          if ($bid) { [void]$btns.Add(@{ id = $bid; text = $txt; tip = $tip }) }
        } catch { }
      }
      $n.buttons = $btns
    }
  } catch { $n.error = Error-Text $_ }
}

function Walk($o, $list) {
  $t = [string](T $o 'Type')
  $n = @{ id = (Rel ([string](T $o 'Id'))); type = $t; name = [string](T $o 'Name') }
  [void]$list.Add($n)
  if ($t -eq 'GuiShell') { Shell-Facts $o $n }
  elseif ($t -eq 'GuiUserArea') {
    # A classic list scrolls with the user area's scrollbar.
    $sb = T $o 'VerticalScrollbar'
    if ($null -ne $sb) {
      $max = T $sb 'Maximum'
      if ($null -ne $max -and [int]$max -gt 0) {
        $n.scroll = @{ position = [int](T $sb 'Position'); maximum = [int]$max; pageSize = [int](T $sb 'PageSize') }
      }
    }
  }
  elseif ($SKIP.ContainsKey($t)) { }
  elseif ($t -eq 'GuiTextField' -or $t -eq 'GuiCTextField' -or $t -eq 'GuiPasswordField') {
    # A password field's content is never read.
    if ($t -ne 'GuiPasswordField') { $n.text = [string](T $o 'Text') }
    $n.tip = [string](T $o 'Tooltip')
    $n.changeable = [bool](T $o 'Changeable')
    $lab = T $o 'LeftLabel'
    if ($null -ne $lab) { $n.label = [string](T $lab 'Text') }
  }
  elseif ($t -eq 'GuiCheckBox' -or $t -eq 'GuiRadioButton') {
    $n.text = [string](T $o 'Text')
    $n.tip = [string](T $o 'Tooltip')
    $n.selected = [bool](T $o 'Selected')
    $n.changeable = [bool](T $o 'Changeable')
  }
  elseif ($t -eq 'GuiComboBox') {
    $n.text = [string](T $o 'Text')
    $n.tip = [string](T $o 'Tooltip')
    $n.key = [string](T $o 'Key')
    $n.changeable = [bool](T $o 'Changeable')
    $lab = T $o 'LeftLabel'
    if ($null -ne $lab) { $n.label = [string](T $lab 'Text') }
    $entries = New-List
    try {
      foreach ($e in (Items (G $o 'Entries'))) { [void]$entries.Add(@([string](G $e 'Key'), [string](G $e 'Value'))) }
    } catch { }
    $n.entries = $entries
  }
  elseif ($t -eq 'GuiButton') {
    $n.text = [string](T $o 'Text')
    $n.tip = [string](T $o 'Tooltip')
    $n.changeable = [bool](T $o 'Changeable')
  }
  elseif ($t -eq 'GuiStatusbar') {
    $n.text = [string](T $o 'Text')
    $n.messageType = [string](T $o 'MessageType')
  }
  elseif ($t -eq 'GuiTableControl') {
    $n.rowCount = T $o 'RowCount'
    $n.visibleRowCount = T $o 'VisibleRowCount'
    $sb = T $o 'VerticalScrollbar'
    if ($null -ne $sb) { $p = T $sb 'Position'; if ($null -ne $p) { $n.firstRow = [int]$p } }
    $titles = New-List
    try {
      foreach ($c in (Items (G $o 'Columns'))) { [void]$titles.Add([string](T $c 'Title')) }
    } catch { }
    $n.columns = $titles
  }
  else {
    $n.text = [string](T $o 'Text')
    $n.tip = [string](T $o 'Tooltip')
    $n.changeable = [bool](T $o 'Changeable')
  }
  if ($t -eq 'GuiMenubar') {
    # Menus are named, not walked: SAP GUI cannot read an open menu.
    $menus = New-List
    foreach ($m in (Items (T $o 'Children'))) { [void]$menus.Add([string](T $m 'Text')) }
    $n.menus = $menus
    return
  }
  $kids = T $o 'Children'
  if ($null -eq $kids) { return }
  $count = [int](T $kids 'Count')
  for ($i = 0; $i -lt $count; $i++) { Walk (G $kids 'ElementAt' @($i)) $list }
}

function Op-Screen($req) {
  $ses = Get-Session (Get-Engine) ([string]$req['session'])
  Wait-Ready $ses
  $script:maxGridRows = 50
  $script:maxTreeNodes = 300
  if ($req.ContainsKey('gridRows')) { $script:maxGridRows = [int]$req['gridRows'] }
  if ($req.ContainsKey('treeNodes')) { $script:maxTreeNodes = [int]$req['treeNodes'] }
  $script:treeFrom = $null
  if ($req.ContainsKey('treeFrom')) { $script:treeFrom = $req['treeFrom'] }
  $script:prefix = [string](T $ses 'Id') + '/'
  $info = T $ses 'Info'
  $res = @{
    transaction = [string](T $info 'Transaction')
    program = [string](T $info 'Program')
    screen = [string](T $info 'ScreenNumber')
    system = [string](T $info 'SystemName')
    client = [string](T $info 'Client')
    language = [string](T $info 'Language')
  }
  $aw = T $ses 'ActiveWindow'
  if ($null -ne $aw) {
    $res.activeWindow = Rel ([string](T $aw 'Id'))
    # The control that has the keyboard focus: Enter acts on it.
    $gf = T $aw 'GuiFocus'
    if ($null -ne $gf) { $res.focus = Rel ([string](T $gf 'Id')) }
  }
  $wins = New-List
  foreach ($w in (Items (G $ses 'Children'))) {
    $ctl = New-List
    Walk $w $ctl
    [void]$wins.Add(@{ id = (Rel ([string](T $w 'Id'))); title = [string](T $w 'Text'); controls = $ctl })
  }
  $res.windows = $wins
  $res
}

# One control by id, for what the screen read does not walk (menu entries).
function Op-Describe($req) {
  $ses = Get-Session (Get-Engine) ([string]$req['session'])
  $script:prefix = [string](T $ses 'Id') + '/'
  $o = T $ses 'FindById' @([string]$req['control'], $false)
  if ($null -eq $o) { return @{ found = $false } }
  @{
    found = $true
    control = @{
      id = (Rel ([string](T $o 'Id'))); type = [string](T $o 'Type'); name = [string](T $o 'Name')
      text = [string](T $o 'Text'); tip = [string](T $o 'Tooltip'); changeable = [bool](T $o 'Changeable')
    }
  }
}

# ---- act --------------------------------------------------------------------------

# Where a scroll goes: a row counted from 0, or next, prev, first, last; kept between 0 and $max.
function Scroll-Target($to, [int]$pos, [int]$page, [int]$max) {
  $t = $pos
  if ($to -is [string]) {
    if ($to -eq 'next') { $t = $pos + $page }
    elseif ($to -eq 'prev') { $t = $pos - $page }
    elseif ($to -eq 'first') { $t = 0 }
    elseif ($to -eq 'last') { $t = $max }
    else { $t = [int]$to }
  }
  elseif ($null -ne $to) { $t = [int]$to }
  else { $t = $pos + $page }
  [Math]::Max(0, [Math]::Min($t, $max))
}

function Op-Act($req) {
  $ses = Get-Session (Get-Engine) ([string]$req['session'])
  Wait-Ready $ses
  $a = $req['action']
  $do = [string]$a['do']
  # Never on the logon screen (program SAPMSYST; its screen 40 is the old start menu, after logon).
  $info = T $ses 'Info'
  if ($null -ne $info -and [string](T $info 'Program') -eq 'SAPMSYST' -and [string](T $info 'ScreenNumber') -notmatch '^0*40$') {
    throw 'LOGON: This server never logs on; log on yourself, then ask again'
  }
  if ($do -eq 'okcode') {
    S (G $ses 'FindById' @('wnd[0]/tbar[0]/okcd')) 'Text' ([string]$a['value'])
    M (G $ses 'FindById' @('wnd[0]')) 'SendVKey' @(0)
    return @{ done = $true }
  }
  if ($do -eq 'key') {
    M (G $ses 'ActiveWindow') 'SendVKey' @([int]$a['key'])
    return @{ done = $true }
  }
  $id = [string]$a['id']
  $o = T $ses 'FindById' @($id, $false)
  if ($null -eq $o) { throw "NOT_FOUND: no control $id" }
  if ($do -eq 'set') {
    # A password is never typed by this server.
    if ([string](T $o 'Type') -eq 'GuiPasswordField') { throw "PASSWORD: $id is a password field" }
    S $o 'Text' ([string]$a['value'])
  }
  elseif ($do -eq 'press') { M $o 'Press' $null }
  elseif ($do -eq 'focus') { M $o 'SetFocus' $null }
  elseif ($do -eq 'dblclick') {
    # Choose a list entry or label: focus, then F2, as a double-click does.
    M $o 'SetFocus' $null
    M (G $ses 'ActiveWindow') 'SendVKey' @(2)
  }
  elseif ($do -eq 'f4') {
    M $o 'SetFocus' $null
    M (G $ses 'ActiveWindow') 'SendVKey' @(4)
  }
  elseif ($do -eq 'check') { S $o 'Selected' ([bool]$a['value']) }
  elseif ($do -eq 'select') { M $o 'Select' $null }
  elseif ($do -eq 'combo') { S $o 'Key' ([string]$a['key']) }
  elseif ($do -eq 'tree') {
    # Node keys are padded with spaces; the view shows them trimmed.
    $node = [string]$a['node']
    foreach ($k in (Strings (G $o 'GetAllNodeKeys'))) { if ($k.Trim() -eq $node.Trim()) { $node = $k; break } }
    $how = [string]$a['how']
    if ($how -eq 'expand') { M $o 'ExpandNode' @($node) }
    elseif ($how -eq 'collapse') { M $o 'CollapseNode' @($node) }
    elseif ($how -eq 'select') { M $o 'SelectNode' @($node) }
    elseif ($a.ContainsKey('col') -and [string]$a['col']) { M $o 'DoubleClickItem' @($node, [string]$a['col']) }
    else { M $o 'DoubleClickNode' @($node) }
  }
  elseif ($do -eq 'scroll') {
    # A grid moves by its first visible row; a table control and a list by their scrollbar.
    $res = @{ done = $true }
    if ([string](T $o 'Type') -eq 'GuiShell') {
      if ([string](T $o 'SubType') -ne 'GridView') { throw "NO_SCROLL: $id does not scroll" }
      $rc = [int](G $o 'RowCount')
      $page = 1
      $v = T $o 'VisibleRowCount'
      if ($null -ne $v -and [int]$v -gt 0) { $page = [int]$v }
      $pos = 0
      $fv = T $o 'FirstVisibleRow'
      if ($null -ne $fv) { $pos = [int]$fv }
      $target = Scroll-Target $a['to'] $pos $page ([Math]::Max(0, $rc - $page))
      if ($target -ne $pos) { S $o 'FirstVisibleRow' $target }
      $res.from = $pos; $res.first = $target; $res.visible = $page; $res.total = $rc
    }
    else {
      $sb = T $o 'VerticalScrollbar'
      if ($null -eq $sb) { throw "NO_SCROLL: $id does not scroll" }
      $pos = [int](T $sb 'Position')
      $max = [int](T $sb 'Maximum')
      $page = [int](T $sb 'PageSize')
      if ($page -lt 1) { $page = 1 }
      $target = Scroll-Target $a['to'] $pos $page $max
      if ($target -ne $pos) { S $sb 'Position' $target }
      $res.from = $pos; $res.first = $target; $res.visible = $page; $res.total = $max + $page
    }
    return $res
  }
  elseif ($do -eq 'grid') {
    $row = [int]$a['row']
    $rc = [int](G $o 'RowCount')
    if ($row -ge $rc) { throw "NOT_FOUND: row $($row): the grid has $rc rows (0 to $($rc - 1))" }
    # A row that is not on screen is scrolled to first: SAP GUI loads rows as they come into view.
    $fv = T $o 'FirstVisibleRow'
    $v = T $o 'VisibleRowCount'
    if ($null -ne $fv -and $null -ne $v -and [int]$v -gt 0 -and ($row -lt [int]$fv -or $row -ge ([int]$fv + [int]$v))) { S $o 'FirstVisibleRow' $row }
    # Without a column (a row selected by "select" with "row"), the cursor stays where it is.
    $how = [string]$a['how']
    if ([string]$a['col']) { M $o 'SetCurrentCell' @($row, [string]$a['col']) }
    if ($how -eq 'select') { S $o 'SelectedRows' ([string]$row) }
    elseif ($how -eq 'unselect') { M $o 'ClearSelection' $null }
    else { M $o 'DoubleClickCurrentCell' $null }
  }
  elseif ($do -eq 'cell') {
    # A cell of an ALV grid that takes input, as SAP GUI records a typed cell:
    # modifyCell row, "COL", "value"; then triggerModified (the grid's data_changed event).
    $row = [int]$a['row']
    $col = [string]$a['col']
    $rc = [int](G $o 'RowCount')
    if ($row -ge $rc) { throw "NOT_FOUND: row $($row): the grid has $rc rows (0 to $($rc - 1))" }
    $fv = T $o 'FirstVisibleRow'
    $v = T $o 'VisibleRowCount'
    if ($null -ne $fv -and $null -ne $v -and [int]$v -gt 0 -and ($row -lt [int]$fv -or $row -ge ([int]$fv + [int]$v))) { S $o 'FirstVisibleRow' $row }
    M $o 'SetCurrentCell' @($row, $col)
    M $o 'ModifyCell' @($row, $col, [string]$a['value'])
    M $o 'TriggerModified' $null
  }
  elseif ($do -eq 'selectrow') {
    # A table control's row, by its number from the table's first row (not from the first one on screen),
    # as a click on its row selector does: GetAbsoluteRow(n).Selected = True. A GuiTableControl has no
    # Select method (calling it was the DISP_E_UNKNOWNNAME), and GetAbsoluteRow is a method call, then
    # Selected a property write on the GuiTableRow it returns.
    $row = [int]$a['row']
    $on = [bool]$a['value']
    $rc = [int](G $o 'RowCount')
    if ($row -ge $rc) { throw "NOT_FOUND: row $($row): the table has $rc rows (0 to $($rc - 1))" }
    # A row that is not on screen is scrolled to first. Scrolling is a roundtrip: the table is found again after it.
    $sb = T $o 'VerticalScrollbar'
    $pos = 0
    if ($null -ne $sb) { $pos = [int](T $sb 'Position') }
    $vis = [int](T $o 'VisibleRowCount')
    if ($null -ne $sb -and $vis -gt 0 -and ($row -lt $pos -or $row -ge ($pos + $vis))) {
      S $sb 'Position' ([Math]::Min($row, [int](T $sb 'Maximum')))
      Wait-Ready $ses
      $o = G $ses 'FindById' @($id)
      $sb = T $o 'VerticalScrollbar'
      if ($null -ne $sb) { $pos = [int](T $sb 'Position') }
    }
    $r = G $o 'GetAbsoluteRow' @($row)
    # Selectable is false where the table has no row selectors; unknown (null) on old SAP GUI: then just try.
    $selectable = T $r 'Selectable'
    if ($null -eq $selectable -or [bool]$selectable) { S $r 'Selected' $on }
    else {
      # No row selector: the row's first checkbox that takes input is its selection (e.g. MSICHTAUSW-KZSEL).
      # GetCell takes the row on screen: the row minus the scrollbar's position.
      $done = $false
      $cols = [int](G (G $o 'Columns') 'Count')
      for ($c = 0; $c -lt $cols -and -not $done; $c++) {
        $cell = T $o 'GetCell' @(($row - $pos), $c)
        if ($null -ne $cell -and [string](T $cell 'Type') -eq 'GuiCheckBox' -and [bool](T $cell 'Changeable')) { S $cell 'Selected' $on; $done = $true }
      }
      if (-not $done) { throw "NOT_SELECTABLE: row $row of $id has no row selector and no checkbox that takes input" }
    }
  }
  elseif ($do -eq 'toolbar') { M $o 'PressToolbarButton' @([string]$a['button']) }
  else { throw "UNKNOWN_ACTION: $do" }
  @{ done = $true }
}

# ---- screenshot -----------------------------------------------------------------

function Op-Screenshot($req) {
  $ses = Get-Session (Get-Engine) ([string]$req['session'])
  Wait-Ready $ses
  $w = T $ses 'ActiveWindow'
  if ($null -eq $w) { $w = G $ses 'FindById' @('wnd[0]') }
  [string]$file = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), 'sapgui-mcp-' + [guid]::NewGuid().ToString('N') + '.png')
  $ret = G $w 'HardCopy' @($file, 2)   # 2 = PNG
  $path = $file
  if ($ret -is [string] -and $ret -and (Test-Path -LiteralPath $ret)) { $path = $ret }
  for ($i = 0; $i -lt 30 -and -not (Test-Path -LiteralPath $path); $i++) { Start-Sleep -Milliseconds 100 }
  if (-not (Test-Path -LiteralPath $path)) { throw 'NO_IMAGE: SAP GUI wrote no screenshot (is the window minimized?)' }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if (-not ($bytes.Length -gt 4 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50 -and $bytes[2] -eq 0x4E -and $bytes[3] -eq 0x47)) {
      # Not PNG after all (older SAP GUI writes BMP): convert.
      Add-Type -AssemblyName System.Drawing
      $ms = New-Object System.IO.MemoryStream(, $bytes)
      $img = [System.Drawing.Image]::FromStream($ms)
      $out = New-Object System.IO.MemoryStream
      $img.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $img.Dispose()
      $bytes = $out.ToArray()
    }
  } finally { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  @{ png = [System.Convert]::ToBase64String($bytes) }
}

# ---- doctor -----------------------------------------------------------------------

# A SAP GUI security setting: the machine-wide value wins over the user's.
function Sap-Setting([string]$name) {
  $paths = 'HKLM:\SOFTWARE\WOW6432Node\SAP\SAPGUI Front\SAP Frontend Server\Security',
    'HKLM:\SOFTWARE\SAP\SAPGUI Front\SAP Frontend Server\Security',
    'HKCU:\Software\SAP\SAPGUI Front\SAP Frontend Server\Security'
  foreach ($p in $paths) {
    try {
      $v = (Get-ItemProperty -Path $p -Name $name -ErrorAction Stop).$name
      if ($null -ne $v) { return @{ value = [int]$v; where = $p.Substring(0, 4) } }
    } catch { }
  }
  $null
}

function Op-DoctorLocal {
  $procs = @(Sap-Processes)
  $res = @{ processes = $procs; settings = @{}; languageMode = [string]$ExecutionContext.SessionState.LanguageMode }
  foreach ($name in 'UserScripting', 'WarnOnAttach', 'WarnOnConnection') { $res.settings[$name] = Sap-Setting $name }
  $res
}

function Op-DoctorEngine {
  $res = @{ engine = $false; connections = (New-List) }
  try { $eng = Get-Engine } catch { $res.error = Error-Text $_; return $res }
  $res.engine = $true
  foreach ($con in (Items (T $eng 'Children'))) {
    $kids = T $con 'Children'
    $count = 0
    if ($null -ne $kids) { $count = [int](T $kids 'Count') }
    [void]$res.connections.Add(@{
        description = [string](T $con 'Description')
        disabledByServer = [bool](T $con 'DisabledByServer')
        sessions = $count
      })
  }
  $res
}

# ---- loop -------------------------------------------------------------------------

function Start-Host {
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = $null
  $sb = New-Object System.Text.StringBuilder
  try {
    $req = $parser.DeserializeObject($line)
    $id = $req['id']
    $op = [string]$req['op']
    $res = $null
    if ($op -eq 'ping') { $res = @{ pong = $true; powershell = $PSVersionTable.PSVersion.ToString() } }
    elseif ($op -eq 'sessions') { $res = Op-Sessions }
    elseif ($op -eq 'info') { $res = Op-Info $req }
    elseif ($op -eq 'screen') { $res = Op-Screen $req }
    elseif ($op -eq 'describe') { $res = Op-Describe $req }
    elseif ($op -eq 'act') { $res = Op-Act $req }
    elseif ($op -eq 'screenshot') { $res = Op-Screenshot $req }
    elseif ($op -eq 'doctor-local') { $res = Op-DoctorLocal }
    elseif ($op -eq 'doctor-engine') { $res = Op-DoctorEngine }
    else { throw "UNKNOWN_OP: $op" }
    Write-Json @{ id = $id; ok = $true; result = $res } $sb
  } catch {
    $sb = New-Object System.Text.StringBuilder
    Write-Json @{ id = $id; ok = $false; error = (Error-Text $_) } $sb
  }
  $writer.WriteLine($sb.ToString())
}
}
