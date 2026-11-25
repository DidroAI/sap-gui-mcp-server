# SAP GUI keyboard, mouse and window facts for the DIAG method, which reads
# the screens from the traffic. The ops: windows, area, buttons, screenshot
# valueset (a dropdown's entries from SAP GUI's cache) and act (okcode, key, vk, press, click, dblclick,
# f4, set, type, combo, wheel).
#
# It reads a SAP GUI window from Win32 and MSAA: its title, its screen area,
# the status bar text (WM_GETTEXT) and the toolbar buttons with their keys.
# It acts with the keyboard and the mouse: the command field, function keys,
# toolbar buttons (BM_CLICK), clicks and typing at a point.
#
# Protocol: the same as ../../sapgui/ps/host-lib.ps1. One JSON object per
# line on stdin ({"id":1,"op":"windows",...}), one per line on stdout.
# Windows PowerShell 5.1 only; nothing to install.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true

Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName System.Drawing
$parser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$parser.MaxJsonLength = 268435456

Add-Type -ReferencedAssemblies System.Drawing, Accessibility -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class SapScreen {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, StringBuilder l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string l, uint flags, uint ms, out IntPtr res);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO gi);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, uint objId, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);

  /** A button's name and description through MSAA: {"Back", "Back   (F3)"}. Empty strings when it gives none. */
  public static string[] Button(IntPtr h) {
    var res = new[] { "", "" };
    try {
      var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71"); object o;
      if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref iid, out o) != 0 || o == null) return res;
      var acc = (Accessibility.IAccessible)o;
      try { res[0] = acc.get_accName(0) ?? ""; } catch { }
      try { res[1] = acc.get_accDescription(0) ?? ""; } catch { }
    } catch { }
    return res;
  }
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  /** BM_CLICK, posted: the button's action may open a popup, and this must not wait for it. */
  public static void PushButton(IntPtr h) { PostMessage(h, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
  /** The window that owns this one (GW_OWNER): a SAP GUI popup is owned by its session window. */
  public static long Owner(IntPtr h) { return (long)GetWindow(h, 4); }

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; [FieldOffset(8)] long pad1; [FieldOffset(16)] long pad2; [FieldOffset(24)] long pad3; [FieldOffset(32)] long pad4; } // 40 bytes on 64-bit Windows: the size SendInput checks
  [StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cb; public int flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT rcCaret; }

  public static void DpiAware() { try { SetProcessDPIAware(); } catch { } }

  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  /** WM_GETTEXT: the text of a control of another process. */
  public static string Text(IntPtr h) {
    var s = new StringBuilder(32768); IntPtr res;
    SendMessageTimeout(h, 0x000D, (IntPtr)32768, s, 2, 500, out res);
    return s.ToString();
  }
  public static void SetText(IntPtr h, string text) { IntPtr res; SendMessageTimeout(h, 0x000C, IntPtr.Zero, text, 2, 1000, out res); }
  public static int[] Rect(IntPtr h) { RECT r; GetWindowRect(h, out r); return new[] { r.L, r.T, r.R - r.L, r.B - r.T }; }
  public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

  /** Top-level windows, topmost first. */
  public static List<IntPtr> TopWindows() {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static List<IntPtr> Children(IntPtr h) {
    var list = new List<IntPtr>();
    for (var c = GetWindow(h, 5); c != IntPtr.Zero; c = GetWindow(c, 2)) list.Add(c);
    return list;
  }
  /** Visible descendants, depth first. */
  public static List<IntPtr> Descendants(IntPtr h) {
    var list = new List<IntPtr>();
    foreach (var c in Children(h)) { if (!IsWindowVisible(c)) continue; list.Add(c); list.AddRange(Descendants(c)); }
    return list;
  }

  public static bool Foreground(IntPtr h) {
    if (GetForegroundWindow() == h) return true;
    uint pid = 0; var fg = GetForegroundWindow();
    uint t = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
    uint mine; GetWindowThreadProcessId(h, out mine);
    // Windows lets a process take the foreground after an Alt tap. SAP GUI opens its menu bar on a lone Alt,
    // and the next Enter would choose a menu entry: tap only while another process is in front, and give
    // that process time to take the tap before SAP GUI comes forward. Op-Act then closes any open menu.
    if (fg == IntPtr.Zero || pid != mine) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(120); }
    if (t != 0) AttachThreadInput(GetCurrentThreadId(), t, true);
    SetForegroundWindow(h);
    if (t != 0) AttachThreadInput(GetCurrentThreadId(), t, false);
    System.Threading.Thread.Sleep(150);
    return GetForegroundWindow() == h;
  }

  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
  /**
   * Page Up/Down, End, Home, the arrows, Insert and Delete are the extended keys. Sent without that flag they are the
   * number pad's, and with Num Lock on Windows lets Shift go for them: Shift+End then only moved to the end, so set
   * typed after what the field held ("5045" became "50455045").
   */
  static bool Extended(byte vk) { return (vk >= 0x21 && vk <= 0x28) || vk == 0x2D || vk == 0x2E; }
  /** One key with modifiers (virtual key codes), to the foreground window. */
  public static void Key(byte vk, bool ctrl, bool shift, bool alt) {
    if (ctrl) keybd_event(0x11, 0, 0, UIntPtr.Zero);
    if (shift) keybd_event(0x10, 0, 0, UIntPtr.Zero);
    if (alt) keybd_event(0x12, 0, 0, UIntPtr.Zero);
    var scan = (byte)MapVirtualKey(vk, 0); uint ext = Extended(vk) ? 1u : 0u;
    keybd_event(vk, scan, ext, UIntPtr.Zero); keybd_event(vk, scan, ext | 2u, UIntPtr.Zero);
    if (alt) keybd_event(0x12, 0, 2, UIntPtr.Zero);
    if (shift) keybd_event(0x10, 0, 2, UIntPtr.Zero);
    if (ctrl) keybd_event(0x11, 0, 2, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
  }
  /** Text as Unicode key events: independent of the keyboard layout. */
  public static void Type(string text) {
    foreach (var ch in text) {
      var down = new INPUT { type = 1 }; down.ki.scan = ch; down.ki.flags = 4;
      var up = new INPUT { type = 1 }; up.ki.scan = ch; up.ki.flags = 6;
      if (SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("FAILED: Windows did not accept the typed text");
      System.Threading.Thread.Sleep(4);
    }
    System.Threading.Thread.Sleep(40);
  }
  /** The mouse wheel at a point, n notches (negative: down). */
  public static void Wheel(int x, int y, int n) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    for (var i = 0; i < Math.Abs(n); i++) { mouse_event(0x0800, 0, 0, unchecked((uint)(n < 0 ? -120 : 120)), UIntPtr.Zero); System.Threading.Thread.Sleep(80); }
  }
  public static void Click(int x, int y, bool twice) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    for (var i = 0; i < (twice ? 2 : 1); i++) { mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); }
  }
  /** Is a menu open (menu bar active or a drop-down shown) in this window's thread? */
  public static bool InMenu(IntPtr top) {
    uint pid; var gi = new GUITHREADINFO(); gi.cb = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, out pid), ref gi)) return false;
    return (gi.flags & 0x14) != 0 || gi.menuOwner != IntPtr.Zero; // GUI_INMENUMODE | GUI_POPUPMENUMODE
  }
  /** Closes an open menu with Esc (in a menu Esc only closes it). */
  public static void LeaveMenu(IntPtr top) {
    for (int i = 0; i < 4 && InMenu(top); i++) { keybd_event(0x1B, 0, 0, UIntPtr.Zero); keybd_event(0x1B, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(80); }
    if (InMenu(top)) throw new InvalidOperationException("MENU_OPEN: a menu stays open in SAP GUI; close it, then ask again");
  }
  /** The window that has the keyboard focus in this window's thread. */
  public static IntPtr Focus(IntPtr top) {
    uint pid; var gi = new GUITHREADINFO(); gi.cb = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, out pid), ref gi)) return IntPtr.Zero;
    return gi.focus;
  }
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  /** Gives the keyboard focus to a window of another thread. */
  public static void GiveFocus(IntPtr h) {
    uint pid; uint t = GetWindowThreadProcessId(h, out pid);
    AttachThreadInput(GetCurrentThreadId(), t, true);
    SetFocus(h);
    AttachThreadInput(GetCurrentThreadId(), t, false);
    System.Threading.Thread.Sleep(60);
  }
  [StructLayout(LayoutKind.Sequential)] struct PT { public int x, y; }
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref PT p);
  /** Is the text caret on the screen row of a point (within half a row)? A click a dropdown's open list swallowed leaves it where it was. */
  public static bool CaretAt(IntPtr top, int y, int half) {
    uint pid; var gi = new GUITHREADINFO(); gi.cb = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, out pid), ref gi) || gi.caret == IntPtr.Zero) return false;
    var p = new PT { x = gi.rcCaret.L, y = (gi.rcCaret.T + gi.rcCaret.B) / 2 };
    if (!ClientToScreen(gi.caret, ref p)) return true;
    return Math.Abs(p.y - y) <= half;
  }
  /** Is a text caret showing in this window's thread? SAP GUI shows one only in a field that takes input. */
  public static bool HasCaret(IntPtr top) {
    uint pid; var gi = new GUITHREADINFO(); gi.cb = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (!GetGUIThreadInfo(GetWindowThreadProcessId(top, out pid), ref gi)) return false;
    return gi.caret != IntPtr.Zero;
  }

  /** A picture of a window, also when another window covers it. */
  public static Bitmap Capture(IntPtr h) {
    RECT r; GetWindowRect(h, out r);
    var bmp = new Bitmap(Math.Max(1, r.R - r.L), Math.Max(1, r.B - r.T), PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      var hdc = g.GetHdc();
      var ok = PrintWindow(h, hdc, 2);
      g.ReleaseHdc(hdc);
      if (!ok) g.CopyFromScreen(r.L, r.T, 0, 0, bmp.Size);
    }
    return bmp;
  }
}
'@
[SapScreen]::DpiAware()

# ---- JSON out (as host-lib.ps1: the serializer of 5.1 mangles nested PowerShell objects) ----

function Write-Json($v, [System.Text.StringBuilder]$sb) {
  if ($null -eq $v) { [void]$sb.Append('null'); return }
  if ($v -is [bool]) { [void]$sb.Append($(if ($v) { 'true' } else { 'false' })); return }
  if ($v -is [string]) { [void]$sb.Append($parser.Serialize([string]$v)); return }
  if ($v -is [int] -or $v -is [long] -or $v -is [uint32] -or $v -is [double] -or $v -is [single]) {
    [void]$sb.Append(([double]$v).ToString([Globalization.CultureInfo]::InvariantCulture)); return
  }
  if ($v -is [System.Collections.IDictionary]) {
    [void]$sb.Append('{'); $first = $true
    foreach ($k in $v.Keys) {
      if (-not $first) { [void]$sb.Append(',') }; $first = $false
      [void]$sb.Append($parser.Serialize([string]$k)); [void]$sb.Append(':')
      Write-Json $v[$k] $sb
    }
    [void]$sb.Append('}'); return
  }
  if ($v -is [System.Collections.IEnumerable]) {
    [void]$sb.Append('['); $first = $true
    foreach ($x in $v) {
      if (-not $first) { [void]$sb.Append(',') }; $first = $false
      Write-Json $x $sb
    }
    [void]$sb.Append(']'); return
  }
  [void]$sb.Append($parser.Serialize([string]$v))
}
function New-List { , (New-Object System.Collections.ArrayList) }
function Error-Text($e) {
  $m = $e.Exception.Message
  if ($e.Exception.InnerException) { $m = $e.Exception.InnerException.Message }
  ($m -replace '\s+', ' ').Trim()
}

# ---- windows --------------------------------------------------------------------

# SAP GUI's session windows are of class SAP_FRONTEND_SESSION; its popups are
# dialogs (#32770) of the same process. SAP Logon itself is left out.
function Sap-Windows {
  $tops = [SapScreen]::TopWindows()
  $pids = @{}
  foreach ($h in $tops) { if ([SapScreen]::Class($h) -eq 'SAP_FRONTEND_SESSION') { $pids[[SapScreen]::Pid($h)] = $true } }
  $out = New-List
  foreach ($h in $tops) {
    $cls = [SapScreen]::Class($h)
    if (-not $pids.ContainsKey([SapScreen]::Pid($h))) { continue }
    # SAP GUI keeps some dialogs alive far off the screen: they are not open.
    $r = [SapScreen]::Rect($h)
    if ($r[0] -le -4000 -or $r[2] -le 0) { continue }
    if ($cls -eq 'SAP_FRONTEND_SESSION') { [void]$out.Add(@{ hwnd = [long]$h; kind = 'session'; title = [SapScreen]::Title($h) }) }
    elseif ($cls -eq '#32770' -and [SapScreen]::Title($h) -notmatch '^SAP Logon') { [void]$out.Add(@{ hwnd = [long]$h; kind = 'popup'; title = [SapScreen]::Title($h); owner = [SapScreen]::Owner($h) }) }
  }
  , $out
}

function Op-Windows {
  $fg = [long][SapScreen]::GetForegroundWindow()
  $list = New-List
  foreach ($w in (Sap-Windows)) {
    $w.foreground = ($w.hwnd -eq $fg); $w.rect = [SapScreen]::Rect([IntPtr]$w.hwnd)
    # The status bar's text tells apart two sessions with the same title (the DIAG method compares it with SAP's message),
    # and its system field ("ABA (1) 800") which system and client a window shows.
    if ($w.kind -eq 'session') { $w.status = (Status-Text ([IntPtr]$w.hwnd) $w.rect); $w.info = (Status-Texts ([IntPtr]$w.hwnd) $w.rect) }
    [void]$list.Add($w)
  }
  # Minimized session windows are listed, never acted on: a window of the same title is not taken for one of them.
  foreach ($h in [SapScreen]::TopWindows()) {
    if ([SapScreen]::Class($h) -eq 'SAP_FRONTEND_SESSION' -and [SapScreen]::IsIconic($h)) { [void]$list.Add(@{ hwnd = [long]$h; kind = 'session'; title = [SapScreen]::Title($h); minimized = $true }) }
  }
  @{ windows = $list }
}

# Every text in a session window's status bar strip, joined: the message and the system field among them.
function Status-Texts([IntPtr]$h, $rect) {
  $texts = New-List
  foreach ($c in [SapScreen]::Descendants($h)) {
    $r = [SapScreen]::Rect($c)
    if ($r[1] -le $rect[1] + $rect[3] - 90) { continue }
    $t = [SapScreen]::Text($c)
    if ($t) { [void]$texts.Add($t) }
  }
  ($texts -join ' | ')
}

# The text of a session window's status bar: the first Edit child with text in its bottom strip.
function Status-Text([IntPtr]$h, $rect) {
  foreach ($c in [SapScreen]::Descendants($h)) {
    if ([SapScreen]::Class($c) -ne 'Edit') { continue }
    $r = [SapScreen]::Rect($c)
    if ($r[1] -le $rect[1] + $rect[3] - 90) { continue }
    $t = [SapScreen]::Text($c)
    if ($t) { return $t }
  }
  ''
}

# The windows of one session, bottom first: the session window, then the
# popups above it. SAP GUI's popups are modal, so the topmost SAP popup
# belongs to the session that is in front.
function Session-Windows([long]$hwnd) {
  $all = Sap-Windows
  $me = $null
  foreach ($w in $all) { if ($w.hwnd -eq $hwnd) { $me = $w } }
  if ($null -eq $me) { throw 'NO_SESSION: this SAP GUI window is closed' }
  $out = New-List
  [void]$out.Add($me)
  $sessions = @($all | Where-Object { $_.kind -eq 'session' })
  $popups = @($all | Where-Object { $_.kind -eq 'popup' })
  # A popup owned by this session window is its own. One whose owner is no session window (owner 0) goes,
  # as before, to the session highest in z-order: SAP GUI's popups are modal.
  $ids = @{}; foreach ($x in $sessions) { $ids[[long]$x.hwnd] = $true }
  $mine = @($popups | Where-Object { [long]$_.owner -eq $hwnd -or (-not $ids.ContainsKey([long]$_.owner) -and $sessions.Count -and $sessions[0].hwnd -eq $hwnd) })
  for ($i = $mine.Count - 1; $i -ge 0; $i--) { [void]$out.Add($mine[$i]) }
  , $out
}

# ---- reading --------------------------------------------------------------------

# The frame: SAP GUI's toolbar buttons are real Windows buttons. Their name
# and the key each is bound to ("Back   (F3)") come through MSAA.
function Frame-Buttons([IntPtr]$top) {
  $out = New-List
  foreach ($c in [SapScreen]::Descendants($top)) {
    if ([SapScreen]::Class($c) -ne 'Button') { continue }
    $r = [SapScreen]::Rect($c)
    if ($r[2] -lt 4 -or $r[3] -lt 4) { continue }
    $b = [SapScreen]::Button($c)
    if (-not $b[0]) { continue }
    [void]$out.Add(@{ name = $b[0]; tip = $b[1]; enabled = [SapScreen]::IsWindowEnabled($c); x = [int]($r[0] + $r[2] / 2); y = [int]($r[1] + $r[3] / 2) })
  }
  , $out
}

# The screen area of a SAP window: its child of class "Afx:<instance>:<style>".
function Screen-Area([IntPtr]$top) {
  foreach ($c in [SapScreen]::Children($top)) {
    if (-not [SapScreen]::IsWindowVisible($c)) { continue }
    $cls = [SapScreen]::Class($c)
    if ($cls -like 'Afx:*' -and ($cls.Split(':').Count -eq 3)) { return $c }
  }
  [IntPtr]::Zero
}

# The entries of a dropdown's value list, from SAP GUI's own cache on this PC: SAP sends a list once and
# then only its id (the traffic has "list C1FE..." and the key chosen); SAP GUI keeps the list in
# %LOCALAPPDATA%\SAP\SAP GUI\Cache\...\DataP_sapvalueset<letter><id>cp<codepage>_<n>, an XML table with a
# LINE per entry (KEY, VALUE) in the order the dropdown shows them. Nothing found: no entries.
function Op-Valueset($req) {
  $id = ([string]$req['list']).Trim()
  if ($id -notmatch '^[0-9A-Fa-f]{32}$') { throw 'BAD_REQUEST: a value list id is 32 hex digits' }
  $root = Join-Path $env:LOCALAPPDATA 'SAP\SAP GUI\Cache'
  $out = New-List
  if (-not (Test-Path $root)) { return @{ entries = $out } }
  $f = Get-ChildItem -Path $root -Recurse -File -Filter "DataP_sapvalueset*$id*" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($null -eq $f) { return @{ entries = $out } }
  $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($f.FullName))
  foreach ($m in [regex]::Matches($text, '<LINE id="\d+" KEY ="([^"]*)" VALUE ="([^"]*)"\s*/>')) {
    [void]$out.Add(@{ key = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value); value = [System.Net.WebUtility]::HtmlDecode($m.Groups[2].Value) })
  }
  @{ entries = $out }
}

# The dynpro area of each window of a session (the session window, then its
# popups), in screen pixels: what DIAG's character cells map onto.
function Op-Area($req) {
  $list = New-List
  foreach ($w in (Session-Windows ([long]$req['session']))) {
    $a = Screen-Area ([IntPtr]$w.hwnd)
    $r = if ($a -ne [IntPtr]::Zero) { [SapScreen]::Rect($a) } else { $null }
    # SAP GUI's controls that are real windows (grids, trees, text editors), with their rects.
    $ctl = New-List
    foreach ($c in [SapScreen]::Descendants([IntPtr]$w.hwnd)) {
      $cls = [SapScreen]::Class($c)
      if (($cls -eq 'SAPALVGrid' -or $cls -eq 'SAPTreeList' -or $cls -eq 'SAP TextEditBody') -and [SapScreen]::IsWindowVisible($c)) { [void]$ctl.Add(@{ cls = $cls; rect = [SapScreen]::Rect($c) }) }
    }
    [void]$list.Add(@{ hwnd = $w.hwnd; kind = $w.kind; title = $w.title; area = $r; controls = $ctl; foreground = ($w.hwnd -eq [long][SapScreen]::GetForegroundWindow()) })
  }
  @{ windows = $list }
}

function Op-Screenshot($req) {
  $wins = Session-Windows ([long]$req['session'])
  $bmp = [SapScreen]::Capture([IntPtr]$wins[$wins.Count - 1].hwnd)
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    @{ png = [Convert]::ToBase64String($ms.ToArray()) }
  } finally { $bmp.Dispose() }
}

# ---- acting ---------------------------------------------------------------------

# A SAP virtual key number as a keystroke: 0 Enter, 1-12 F1-F12, 13-24 with
# Shift, 25-36 with Ctrl, 37-48 with Ctrl+Shift, and the named few.
function Send-VKey([int]$n) {
  if ($n -eq 0) { [SapScreen]::Key(0x0D, $false, $false, $false); return }
  if ($n -ge 1 -and $n -le 48) {
    $f = (($n - 1) % 12) + 1; $band = [int][Math]::Floor(($n - 1) / 12)
    [SapScreen]::Key([byte](0x6F + $f), ($band -ge 2), ($band -eq 1 -or $band -eq 3), $false); return
  }
  switch ($n) {
    70 { [SapScreen]::Key(0x45, $true, $false, $false) }  # Ctrl+E
    71 { [SapScreen]::Key(0x46, $true, $false, $false) }  # Ctrl+F
    80 { [SapScreen]::Key(0x21, $true, $false, $false) }  # Ctrl+PgUp
    81 { [SapScreen]::Key(0x21, $false, $false, $false) } # PgUp
    82 { [SapScreen]::Key(0x22, $false, $false, $false) } # PgDn
    83 { [SapScreen]::Key(0x22, $true, $false, $false) }  # Ctrl+PgDn
    84 { [SapScreen]::Key(0x47, $true, $false, $false) }  # Ctrl+G
    86 { [SapScreen]::Key(0x50, $true, $false, $false) }  # Ctrl+P
    default { throw "BAD_KEY: no keystroke known for virtual key $n" }
  }
}

function Point($a) {
  if ($null -eq $a['x'] -or $null -eq $a['y']) { throw 'BAD_ACTION: this action needs a point' }
  @([int]$a['x'], [int]$a['y'])
}

function Op-Act($req) {
  $wins = Session-Windows ([long]$req['session'])
  # The DIAG method knows from the traffic whether this session has a popup open: "main" = it has none,
  # whatever other SAP dialogs (another connection's error message) are on the desktop.
  if ($req['main']) { $wins = @($wins[0]) }
  $top = [IntPtr]$wins[$wins.Count - 1].hwnd
  $a = $req['action']
  $do = [string]$a['do']
  if (-not [SapScreen]::Foreground($top)) { throw 'NO_FOREGROUND: Windows did not let this window come to the front' }
  [SapScreen]::LeaveMenu($top)
  $note = $null
  if ($do -eq 'okcode') {
    if ($wins.Count -gt 1) { throw 'POPUP: a popup is open; answer it first' }
    $edit = [IntPtr]::Zero
    foreach ($c in [SapScreen]::Descendants($top)) { if ([SapScreen]::Class($c) -eq 'Edit') { $p = [SapScreen]::Rect($c); $r = [SapScreen]::Rect($top); if ($p[1] -lt $r[1] + 160) { $edit = $c; break } } }
    if ($edit -eq [IntPtr]::Zero) { throw 'NOT_FOUND: this window has no command field (it may be hidden: show it with the arrow next to the green tick)' }
    $r = [SapScreen]::Rect($edit)
    [SapScreen]::Click([int]($r[0] + $r[2] / 2), [int]($r[1] + $r[3] / 2), $false)
    # A tree or grid (an ActiveX control) can keep the keyboard after the click: its Enter then never reaches the
    # command field, and SAP GUI sends nothing. Give the field the focus, and check it has it before Enter.
    if ([SapScreen]::Focus($top) -ne $edit) { [SapScreen]::GiveFocus($edit) }
    [SapScreen]::SetText($edit, [string]$a['value'])
    Start-Sleep -Milliseconds 80
    if ([SapScreen]::Text($edit) -ne [string]$a['value']) { throw 'FAILED: the command field did not take the text' }
    if ([SapScreen]::Focus($top) -ne $edit) { throw 'FAILED: the command field did not take the keyboard focus (a control on the screen kept it); press Back or click a field, then send the okcode again' }
    [SapScreen]::Key(0x0D, $false, $false, $false)
  }
  elseif ($do -eq 'key') { Send-VKey ([int]$a['key']) }
  elseif ($do -eq 'vk') {
    # A Windows key with modifiers, count times: Home, the arrows, Page Down, Enter, Shift+Space...
    $n = [Math]::Max(1, [int]$a['count'])
    for ($i = 0; $i -lt $n; $i++) { [SapScreen]::Key([byte][int]$a['vk'], [bool]$a['ctrl'], [bool]$a['shift'], [bool]$a['alt']) }
  }
  elseif ($do -eq 'press') {
    # A toolbar button by its name: a posted BM_CLICK, no mouse. "within": only a button whose middle is in that rect (a grid's toolbar).
    $name = [string]$a['name']
    $in = $a['within']
    $hit = [IntPtr]::Zero
    foreach ($c in [SapScreen]::Descendants($top)) {
      if ([SapScreen]::Class($c) -ne 'Button') { continue }
      $r = [SapScreen]::Rect($c)
      if ($r[2] -lt 4 -or $r[3] -lt 4) { continue }
      if ($null -ne $in) { $mx = $r[0] + $r[2] / 2; $my = $r[1] + $r[3] / 2; if ($mx -lt $in[0] -or $mx -gt $in[0] + $in[2] -or $my -lt $in[1] -or $my -gt $in[1] + $in[3]) { continue } }
      if ([SapScreen]::Button($c)[0] -eq $name) { $hit = $c; break }
    }
    if ($hit -eq [IntPtr]::Zero) { throw "NOT_FOUND: no button named $name" }
    if (-not [SapScreen]::IsWindowEnabled($hit)) { throw "DISABLED: the button $name is disabled" }
    [SapScreen]::PushButton($hit)
  }
  elseif ($do -eq 'click' -or $do -eq 'dblclick') { $p = Point $a; [SapScreen]::Click($p[0], $p[1], ($do -eq 'dblclick')) }
  elseif ($do -eq 'f4') { $p = Point $a; [SapScreen]::Click($p[0], $p[1], $false); Start-Sleep -Milliseconds 150; [SapScreen]::Key(0x73, $false, $false, $false) }
  elseif ($do -eq 'set') {
    $p = Point $a
    [SapScreen]::Click($p[0], $p[1], $false)
    Start-Sleep -Milliseconds 200
    # A dropdown chosen just before can swallow the first click (its list closes on it): click once more when the caret did not come.
    if ([SapScreen]::HasCaret($top) -and -not [SapScreen]::CaretAt($top, $p[1], 16)) { [SapScreen]::Click($p[0], $p[1], $false); Start-Sleep -Milliseconds 200 }
    if (-not [SapScreen]::HasCaret($top)) { throw 'NOT_INPUT: no text cursor appeared at this point: it is not a field that takes input' }
    if (-not [SapScreen]::CaretAt($top, $p[1], 16)) { throw 'NOT_INPUT: the text cursor did not come to this point: nothing was typed' }
    [SapScreen]::Key(0x24, $false, $false, $false)  # Home
    [SapScreen]::Key(0x23, $false, $true, $false)   # Shift+End
    [SapScreen]::Key(0x2E, $false, $false, $false)  # Delete
    [SapScreen]::Type([string]$a['value'])
  }
  elseif ($do -eq 'type') { [SapScreen]::Type([string]$a['value']) }
  elseif ($do -eq 'wheel') { $p = Point $a; [SapScreen]::Wheel($p[0], $p[1], [int]$a['notches']) }
  elseif ($do -eq 'combo') {
    # A dropdown in one go, with no other window brought forward between its keys (that closes an open list):
    # the click opens the list, then the entry by its text (type) or by its place (arrows: Home, Down n), Enter.
    $p = Point $a
    [SapScreen]::Click($p[0], $p[1], $false)
    Start-Sleep -Milliseconds 350
    if ($a['how'] -eq 'arrows') {
      [SapScreen]::Key(0x24, $false, $false, $false)
      for ($i = 0; $i -lt [int]$a['index']; $i++) { [SapScreen]::Key(0x28, $false, $false, $false) }
    } else { [SapScreen]::Type([string]$a['value']) }
    # The list takes the typed text a moment after the keys: Enter too soon takes the entry before.
    Start-Sleep -Milliseconds 300
    [SapScreen]::Key(0x0D, $false, $false, $false)
    Start-Sleep -Milliseconds 300
  }
  else { throw "UNKNOWN_ACTION: $do" }
  Start-Sleep -Milliseconds ([int]$(if ($null -ne $a['settle']) { $a['settle'] } else { 600 }))
  @{ done = $true }
}

# ---- loop -----------------------------------------------------------------------

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
      elseif ($op -eq 'windows') { $res = Op-Windows }
      elseif ($op -eq 'act') { $res = Op-Act $req }
      elseif ($op -eq 'area') { $res = Op-Area $req }
      elseif ($op -eq 'buttons') { $res = @{ buttons = (Frame-Buttons ([IntPtr][long]$req['session'])) } }
      elseif ($op -eq 'screenshot') { $res = Op-Screenshot $req }
      elseif ($op -eq 'valueset') { $res = Op-Valueset $req }
      else { throw "UNKNOWN_OP: $op" }
      Write-Json @{ id = $id; ok = $true; result = $res } $sb
    } catch {
      $sb = New-Object System.Text.StringBuilder
      Write-Json @{ id = $id; ok = $false; error = (Error-Text $_) } $sb
    }
    $writer.WriteLine($sb.ToString())
  }
}
