import { execFile } from "node:child_process";

import { DesktopError } from "../actions.mjs";

/**
 * Windows desktop driver: one fixed PowerShell script with a small C# helper
 * (SendInput, SetForegroundWindow, screen capture, UI Automation).
 *
 * The script never changes. Each call starts `powershell.exe -NoProfile
 * -NonInteractive -EncodedCommand <script>` and hands the command to it as
 * JSON on stdin, so nothing the model proposes is ever parsed as PowerShell.
 * Text is typed with KEYEVENTF_UNICODE, which needs no escaping and cannot be
 * reinterpreted as a key chord the way SendKeys syntax can.
 */

/** Virtual-key codes for the key names desktop actions allow. */
export const VIRTUAL_KEYS = Object.freeze({
  ctrl: 0x11, alt: 0x12, shift: 0x10, win: 0x5b, enter: 0x0d, tab: 0x09, esc: 0x1b, space: 0x20, backspace: 0x08,
  delete: 0x2e, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27, insert: 0x2d,
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
  ...Object.fromEntries("abcdefghijklmnopqrstuvwxyz".split("").map((c) => [c, c.toUpperCase().charCodeAt(0)])),
  ...Object.fromEntries("0123456789".split("").map((c) => [c, c.charCodeAt(0)])),
});

export function virtualKeys(keys) {
  return keys.split("+").map((k) => {
    const code = VIRTUAL_KEYS[k];
    if (code === undefined) throw new DesktopError("INVALID_ACTION", `Unknown key: ${k}.`);
    return code;
  });
}

export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$cmd = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Drawing, System.Windows.Forms, UIAutomationClient, UIAutomationTypes
if (-not ('AtlasInput' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AtlasInput {
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public InputUnion u; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  static void Send(INPUT[] i) { SendInput((uint)i.Length, i, Marshal.SizeOf(typeof(INPUT))); }
  static INPUT Mouse(uint flags, int data) { var i = new INPUT(); i.type = 0; i.u.mi.dwFlags = flags; i.u.mi.mouseData = data; return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { var i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; return i; }
  public static void Click(string button, bool dbl) {
    uint down = 0x2, up = 0x4;
    if (button == "right") { down = 0x8; up = 0x10; } else if (button == "middle") { down = 0x20; up = 0x40; }
    int times = dbl ? 2 : 1;
    for (int n = 0; n < times; n++) Send(new[] { Mouse(down, 0), Mouse(up, 0) });
  }
  public static void Wheel(int dy, int dx) {
    if (dy != 0) Send(new[] { Mouse(0x800, -dy * 120) });
    if (dx != 0) Send(new[] { Mouse(0x1000, dx * 120) });
  }
  public static void Chord(ushort[] vks) {
    var list = new System.Collections.Generic.List<INPUT>();
    foreach (var vk in vks) list.Add(Key(vk, 0, 0));
    for (int n = vks.Length - 1; n >= 0; n--) list.Add(Key(vks[n], 0, 0x2));
    Send(list.ToArray());
  }
  public static void Type(string text) {
    foreach (var ch in text) Send(new[] { Key(0, ch, 0x4), Key(0, ch, 0x4 | 0x2) });
  }
  public static string ForegroundTitle() { var s = new StringBuilder(512); GetWindowText(GetForegroundWindow(), s, 512); return s.ToString(); }
}
'@
}
function Out($value) { $value | ConvertTo-Json -Depth 8 -Compress }
function Windows() {
  Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
    [pscustomobject]@{ id = [string]$_.MainWindowHandle; title = $_.MainWindowTitle; process = $_.ProcessName }
  }
}
function Tree($element, $depth, [ref]$budget) {
  if ($budget.Value -le 0 -or $depth -gt 6) { return $null }
  $budget.Value--
  $c = $element.Current
  $node = [ordered]@{ role = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''; name = $c.Name }
  $r = $c.BoundingRectangle
  if (-not $r.IsEmpty) { $node.bounds = @{ x = [int]$r.X; y = [int]$r.Y; width = [int]$r.Width; height = [int]$r.Height } }
  $kids = @()
  $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
  while ($child -ne $null -and $budget.Value -gt 0) {
    $k = Tree $child ($depth + 1) $budget
    if ($k) { $kids += $k }
    $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
  }
  if ($kids.Count) { $node.children = $kids }
  return $node
}
switch ($cmd.op) {
  'screenshot' {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    Out @{ png = [Convert]::ToBase64String($ms.ToArray()) }
  }
  'windows' { Out @{ windows = @(Windows) } }
  'active' { Out @{ title = [AtlasInput]::ForegroundTitle() } }
  'inspect' {
    $root = [System.Windows.Automation.AutomationElement]::FocusedElement
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $top = $root
    while ($true) { $p = $walker.GetParent($top); if ($p -eq $null -or $p -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }; $top = $p }
    $budget = [int]$cmd.maxNodes
    Out @{ window = @{ title = [AtlasInput]::ForegroundTitle() }; tree = @(Tree $top 0 ([ref]$budget)) }
  }
  'focus' {
    $w = Windows | Where-Object { $_.title -like ('*' + [System.Management.Automation.WildcardPattern]::Escape($cmd.title) + '*') } | Select-Object -First 1
    if (-not $w) { Out @{ error = 'WINDOW_NOT_FOUND' }; break }
    [AtlasInput]::ShowWindow([IntPtr][long]$w.id, 9) | Out-Null
    [AtlasInput]::SetForegroundWindow([IntPtr][long]$w.id) | Out-Null
    Out @{ title = $w.title }
  }
  'click' { [AtlasInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null; [AtlasInput]::Click([string]$cmd.button, [bool]$cmd.double); Out @{ ok = $true } }
  'move' { [AtlasInput]::SetCursorPos([int]$cmd.x, [int]$cmd.y) | Out-Null; Out @{ ok = $true } }
  'type' { [AtlasInput]::Type([string]$cmd.text); Out @{ ok = $true } }
  'key' { [AtlasInput]::Chord([uint16[]]@($cmd.vks)); Out @{ ok = $true } }
  'scroll' { [AtlasInput]::Wheel([int]$cmd.dy, [int]$cmd.dx); Out @{ ok = $true } }
  'launch' { Start-Process -FilePath ([string]$cmd.app) | Out-Null; Out @{ ok = $true } }
  'clipboard_read' { Out @{ text = [string](Get-Clipboard -Raw) } }
  'clipboard_write' { Set-Clipboard -Value ([string]$cmd.text); Out @{ ok = $true } }
  default { Out @{ error = 'UNKNOWN_OP' } }
}
`;

/** UTF-16LE base64, the encoding powershell.exe -EncodedCommand expects. */
export function encodeCommand(script = WINDOWS_SCRIPT) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Maps a launch_app name to what Start-Process should run. */
const LAUNCH_TARGETS = { calculator: "calc.exe", calc: "calc.exe", notepad: "notepad.exe", explorer: "explorer.exe", "file explorer": "explorer.exe", edge: "msedge.exe", msedge: "msedge.exe", chrome: "chrome.exe", firefox: "firefox.exe", code: "code", vscode: "code" };

export function createWindowsDriver({ exec = execFile, powershell = "powershell.exe", maxNodes = 400 } = {}) {
  const encoded = encodeCommand();
  function call(command, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const child = exec(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
          if (error) {
            reject(new DesktopError(error.code === "ENOENT" ? "TOOL_MISSING" : "DRIVER_FAILED",
              error.code === "ENOENT" ? "PowerShell is not available." : `The desktop driver failed: ${String(stderr).trim().slice(0, 300) || error.message}`,
              error.code === "ENOENT" ? { blocked: "BLOCKED_BY_CAPABILITY", unblock: "Run the companion on Windows with PowerShell available." } : {}));
            return;
          }
          let value;
          try { value = JSON.parse(String(stdout).trim() || "{}"); } catch { reject(new DesktopError("DRIVER_FAILED", "The desktop driver returned unreadable output.")); return; }
          if (value.error === "WINDOW_NOT_FOUND") reject(new DesktopError("WINDOW_NOT_FOUND", `No window titled like “${command.title}”.`));
          else if (value.error) reject(new DesktopError("DRIVER_FAILED", `Desktop driver error: ${value.error}`));
          else resolve(value);
        });
      child.stdin?.end(JSON.stringify(command));
    });
  }
  return {
    platform: "windows",
    async screenshot() { return Buffer.from((await call({ op: "screenshot" })).png, "base64"); },
    async windows() { return (await call({ op: "windows" })).windows ?? []; },
    async activeWindow() { return { id: null, title: (await call({ op: "active" })).title ?? "" }; },
    async inspect() { return call({ op: "inspect", maxNodes }); },
    async focus(title) { return call({ op: "focus", title }); },
    async click({ x, y, button, double }) { await call({ op: "click", x, y, button, double }); },
    async move({ x, y }) { await call({ op: "move", x, y }); },
    async type(text) { await call({ op: "type", text }, 60_000); },
    async key(keys) { await call({ op: "key", vks: virtualKeys(keys) }); },
    async scroll({ dx, dy }) { await call({ op: "scroll", dx, dy }); },
    async launch(app) { await call({ op: "launch", app: LAUNCH_TARGETS[app.toLowerCase()] ?? app }); },
    async clipboardRead() { return (await call({ op: "clipboard_read" })).text ?? ""; },
    async clipboardWrite(text) { await call({ op: "clipboard_write", text }); },
  };
}
