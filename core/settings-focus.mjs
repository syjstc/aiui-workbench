import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, id, normalizeEnvironment, readJson, sha } from './util.mjs';

// A Rokid widget can cover the Settings activity while it is still resumed.
// Only the actual input window tells us whether the user is navigating Settings.
const currentWindow = "dumpsys window displays | sed -n '/mCurrentFocus=/p; /mFocusedApp=/p'";

function endReader(reader) {
  if (!reader) return;
  reader.child.stdin.end();
  const timer = setTimeout(() => reader.child.kill(), 2000);
  timer.unref();
  return reader.done.finally(() => clearTimeout(timer));
}

export class SettingsFocus {
  constructor(adb) { this.adb = adb; this.sessions = new Map(); }

  acquire(device, { temporary = false } = {}) {
    if (device?.status !== 'device' || !/^RG[ _-]glasses$/i.test(device.name)) return () => {};
    const { serial } = device;
    let session = this.sessions.get(serial);
    if (!session || session.abort.signal.aborted) {
      const previous = session?.done;
      session = { owners: 0, opened: false, abort: new AbortController() };
      this.sessions.set(serial, session);
      session.done = Promise.resolve(previous).then(() => this.run(serial, session)).catch(() => {}).finally(() => {
        if (this.sessions.get(serial) === session) this.sessions.delete(serial);
      });
    }
    if (temporary) { session.opened = true; return () => {}; }
    session.owners++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--session.owners === 0 && !session.opened) session.abort.abort();
    };
  }

  async run(serial, session) {
    const directory = path.join(this.adb.root || ROOT, 'assets/wireless-helper');
    const apk = path.join(directory, 'aiui-wireless-helper.apk');
    const [manifest, bytes] = await Promise.all([readJson(path.join(directory, 'manifest.json'), null), fs.readFile(apk)]);
    if (!manifest || sha(bytes) !== manifest.sha256) return;
    const executable = await this.adb.resolve(), remote = '/data/local/tmp/aiui-settings-focus-' + id() + '.apk';
    const signal = session.abort.signal;
    let attemptedUpload = false, reader = null, otherWindows = 0, retryAt = 0;
    try {
      while (!signal.aborted) {
        const result = await this.adb.capture(['-s', serial, 'shell', '-T', currentWindow], { signal, timeout: 5000 });
        if (result.code) break;
        const lines = result.stdout.toString().split('\n');
        const window = lines.find(line => line.includes('mCurrentFocus=')) || '';
        const activity = lines.find(line => line.includes('mFocusedApp=')) || '';
        if (/\bu\d+ com\.android\.settings\//.test(window)) {
          otherWindows = 0;
          if (!attemptedUpload) {
            attemptedUpload = true;
            const push = await this.adb.capture(['-s', serial, 'push', apk, remote], { signal, timeout: 10000 });
            if (push.code) break;
          }
          if (!reader && Date.now() >= retryAt) {
            signal.throwIfAborted();
            const child = spawn(executable, ['-s', serial, 'shell', '-T',
              'CLASSPATH=' + remote + ' exec app_process / com.aiui.workbench.wireless.SettingsFocus'], {
              shell: false, windowsHide: true, env: normalizeEnvironment(this.adb.env), stdio: ['pipe', 'ignore', 'ignore'],
            });
            child.stdin.on('error', () => {});
            const done = new Promise(resolve => { child.once('error', resolve); child.once('close', resolve); });
            reader = { child, done };
            done.then(() => { reader = null; retryAt = Date.now() + 10000; });
          }
        } else {
          // Release Android's automation connection as soon as the user leaves
          // Settings, including when another glasses widget covers the activity.
          if (reader) await endReader(reader);
          retryAt = 0;
          if (/\bu\d+ (?:com\.android\.settings\/|com\.aiui\.workbench\.wireless\/|com\.android\.systemui\/[^}]*WifiDebuggingActivity)/.test(activity)) otherWindows = 0;
          else if (++otherWindows >= 3) session.opened = false;
          if (!session.opened && !session.owners) { session.abort.abort(); break; }
        }
        await delay(1500, undefined, { signal, ref: false });
      }
    } finally {
      await endReader(reader);
      if (attemptedUpload) await this.adb.capture(['-s', serial, 'shell', 'rm', '-f', remote], { timeout: 2000 }).catch(() => {});
    }
  }

  async close() {
    const active = [...this.sessions.values()];
    for (const session of active) session.abort.abort();
    await Promise.all(active.map(session => session.done));
  }
}
