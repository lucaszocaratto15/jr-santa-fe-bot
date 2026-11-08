/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { win32 } from 'node:path';

/**
 * Foreground-window samplers. Both read one stdin line per request and answer with one JSON
 * line `{"app":string,"title":string|null}`. They only read the foreground app name and its
 * window title: no input hooks, no screen content. EOF on stdin ends the process.
 */

/**
 * Windows: `GetForegroundWindow` + `GetWindowText` + `GetWindowThreadProcessId`. The app name is
 * the executable's FileDescription, falling back to ProcessName (elevated processes refuse
 * `MainModule`).
 */
export const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JrLearnForeground {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
while ($true) {
  $request = [Console]::In.ReadLine()
  if ($null -eq $request) { break }
  $app = ''
  $title = $null
  try {
    $handle = [JrLearnForeground]::GetForegroundWindow()
    if ($handle -ne [IntPtr]::Zero) {
      $length = [JrLearnForeground]::GetWindowTextLength($handle)
      $builder = New-Object System.Text.StringBuilder ($length + 1)
      [void][JrLearnForeground]::GetWindowText($handle, $builder, $builder.Capacity)
      $title = $builder.ToString()
      $processId = [uint32]0
      [void][JrLearnForeground]::GetWindowThreadProcessId($handle, [ref]$processId)
      $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
      if ($process) {
        try { $app = $process.MainModule.FileVersionInfo.FileDescription } catch { $app = '' }
        if (-not $app) { $app = $process.ProcessName }
      }
    }
  } catch { }
  $reply = @{ app = [string]$app; title = $title } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
`;

/**
 * macOS (JXA): the app from NSWorkspace (no permission needed), the title from the first
 * on-screen layer-0 window of that PID in CGWindowListCopyWindowInfo. Without the Screen
 * Recording permission `kCGWindowName` is absent and the title is null. The run loop is pumped
 * briefly per request so NSWorkspace sees focus changes. `console.log` goes to stderr in JXA,
 * so replies are written through NSFileHandle.
 */
export const MAC_SCRIPT = String.raw`
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function reply(obj) {
  var text = $(JSON.stringify(obj) + '\n');
  stdout.writeData(text.dataUsingEncoding($.NSUTF8StringEncoding));
}
function str(value) {
  if (!value || (value.isNil && value.isNil())) return null;
  var out = ObjC.unwrap(value);
  return typeof out === 'string' ? out : null;
}
function windows() {
  // kCGWindowListOptionOnScreenOnly (1) | kCGWindowListExcludeDesktopElements (16)
  return ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0));
}
function frontmost() {
  var app = '';
  var pid = -1;
  try {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (front && !front.isNil()) {
      app = str(front.localizedName) || '';
      pid = front.processIdentifier;
    }
  } catch (e) {}
  var title = null;
  try {
    var list = windows();
    var count = list.count;
    for (var i = 0; i < count; i++) {
      var info = list.objectAtIndex(i);
      var layer = info.objectForKey('kCGWindowLayer');
      if (!layer || layer.isNil() || layer.intValue !== 0) continue;
      var owner = info.objectForKey('kCGWindowOwnerPID');
      var ownerPid = owner && !owner.isNil() ? owner.intValue : -2;
      if (pid === -1) {
        pid = ownerPid;
        app = str(info.objectForKey('kCGWindowOwnerName')) || '';
      }
      if (ownerPid !== pid) continue;
      title = str(info.objectForKey('kCGWindowName'));
      break;
    }
  } catch (e) {}
  return { app: app, title: title };
}
var buffer = '';
while (true) {
  var data = stdin.availableData;
  if (data.length === 0) break;
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  var index = buffer.indexOf('\n');
  while (index >= 0) {
    buffer = buffer.slice(index + 1);
    reply(frontmost());
    index = buffer.indexOf('\n');
  }
}
`;

export type SamplerCommand = { command: string; args: string[] };

/** The child-process command for this OS, or null where the feature is unavailable. */
export function samplerCommand(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined> = process.env
): SamplerCommand | null {
  if (platform === 'win32') {
    const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
    return {
      command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
      ],
    };
  }
  if (platform === 'darwin') {
    return { command: '/usr/bin/osascript', args: ['-l', 'JavaScript', '-e', MAC_SCRIPT] };
  }
  return null;
}
