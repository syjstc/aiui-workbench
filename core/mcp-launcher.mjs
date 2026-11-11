import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, atomicJson, id, readJson } from './util.mjs';
import { APP_VERSION } from './version.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// The configuration refers to this user-owned location, not a release folder.
// Opening a new Workshop installation atomically replaces the launch target.
export async function installMcpLauncher(home, { root = ROOT, executable = process.execPath, platform = process.platform } = {}) {
  const directory = path.join(home, 'mcp');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = { schemaVersion: 1, version: APP_VERSION, root, executable, entry: path.join(root, 'mcp/server.mjs') };
  await atomicJson(path.join(directory, 'installation.json'), target);
  const env = { AIUI_WORKBENCH_HOME: home, ELECTRON_RUN_AS_NODE: '1' };
  if (platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
    // PowerShell's native command pipeline does not pass its own stdin through
    // to the child. Copy raw streams so MCP framing and UTF-8 stay intact.
    const script = [
      "$ErrorActionPreference='Stop'",
      "$target=Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $env:AIUI_WORKBENCH_HOME 'mcp/installation.json') | ConvertFrom-Json",
      "$info=New-Object System.Diagnostics.ProcessStartInfo",
      "$info.FileName=$target.executable",
      "$info.Arguments='\"'+$target.entry+'\"'",
      "$info.WorkingDirectory=$target.root",
      "$info.UseShellExecute=$false",
      "$info.CreateNoWindow=$true",
      "$info.RedirectStandardInput=$true",
      "$info.RedirectStandardOutput=$true",
      "$info.RedirectStandardError=$true",
      "$info.EnvironmentVariables['ELECTRON_RUN_AS_NODE']='1'",
      "$child=New-Object System.Diagnostics.Process",
      "$child.StartInfo=$info",
      "[void]$child.Start()",
      "$source=[Console]::OpenStandardInput()",
      "$buffer=New-Object byte[] 65536",
      "$inputRead=$source.ReadAsync($buffer,0,$buffer.Length)",
      "$outputCopy=$child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())",
      "$errorCopy=$child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())",
      "$inputClosed=$false",
      "while(-not $child.WaitForExit(25)){if(-not $inputClosed -and $inputRead.IsCompleted){$count=$inputRead.GetAwaiter().GetResult();if($count -eq 0){$child.StandardInput.Close();$inputClosed=$true}else{$child.StandardInput.BaseStream.Write($buffer,0,$count);$child.StandardInput.BaseStream.Flush();$inputRead=$source.ReadAsync($buffer,0,$buffer.Length)}}}",
      "$outputCopy.GetAwaiter().GetResult()",
      "$errorCopy.GetAwaiter().GetResult()",
      "exit $child.ExitCode",
    ].join('; ');
    return { mcpServers: { 'aiui-workbench': { command: path.win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], env } } };
  }
  const launcher = path.join(directory, 'launch.sh'), temporary = launcher + '.' + id() + '.tmp';
  try {
    await fs.writeFile(temporary, '#!/bin/sh\nset -eu\nexport ELECTRON_RUN_AS_NODE=1\nexec ' + quote(executable) + ' ' + quote(target.entry) + '\n', { mode: 0o700 });
    await fs.rename(temporary, launcher);
  } finally { await fs.rm(temporary, { force: true }); }
  return { mcpServers: { 'aiui-workbench': { command: '/bin/sh', args: [launcher], env } } };
}

export async function mcpInstallation(home) {
  const value = await readJson(path.join(home, 'mcp/installation.json'), null);
  if (!value || !path.isAbsolute(value.executable || '') || !path.isAbsolute(value.root || '')) return null;
  await Promise.all([fs.access(value.executable), fs.access(path.join(value.root, 'core/daemon.mjs'))]);
  return value;
}
