import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson, sha, id } from './util.mjs';

export async function deviceAdbTrust(adb, serial, { revoke = false, root = adb.root || ROOT } = {}) {
  const directory = path.join(root, 'assets/android-debug');
  const [manifest, bytes] = await Promise.all([
    readJson(path.join(directory, 'manifest.json'), null),
    fs.readFile(path.join(directory, 'adb-trust.jar')),
  ]);
  if (!manifest || bytes.length !== manifest.bytes || sha(bytes) !== manifest.sha256) throw new Error('内置授权重置组件不完整，请使用完整工坊安装包。');
  const remote = '/data/local/tmp/aiui-adb-trust-' + id() + '.jar';
  try {
    const pushed = await adb.execute(['-s', serial, 'push', path.join(directory, 'adb-trust.jar'), remote], { timeout: 10000 });
    const command = ['CLASSPATH=' + remote, 'app_process', '/', 'com.aiui.workbench.AdbTrust', revoke ? 'revoke' : 'inspect', remote];
    let result;
    if (!pushed.code) {
      result = await adb.execute(['-s', serial, 'shell', ...command], { timeout: 8000 });
    } else {
      if (!/closed|unknown service|not supported/i.test(pushed.output)) throw new Error('无法准备眼镜授权重置，请确认眼镜已连接并允许调试。');
      // Some firmware offers an authorized shell but closes the ADB sync service.
      const script = [
        'set -e', 'umask 077', "trap 'rm -f " + remote + "' EXIT",
        "base64 -d > " + remote + " <<'WORKSHOP_JAR'", bytes.toString('base64'), 'WORKSHOP_JAR',
        'test "$(sha256sum ' + remote + " | cut -d' ' -f1)\" = " + manifest.sha256,
        command.join(' '), '',
      ].join('\n');
      result = await adb.execute(['-s', serial, 'shell', '-T', 'sh', '-s'], { input: script, timeout: 12000 });
    }
    const receipt = result.output.match(/(?:^|\n)AIUI_ADB_TRUST=(\{[^\r\n]+\})/);
    if (result.code || !receipt) throw new Error('眼镜未返回授权重置回执，请在眼镜端撤销调试授权。');
    const value = JSON.parse(receipt[1]);
    return { supported: value.supported === true, revoked: value.revoked === true && value.remainingCount === 0, pairedCount: value.pairedCount, remainingCount: value.remainingCount };
  } finally {
    // The helper also removes itself, including when revocation drops ADB.
    await adb.execute(['-s', serial, 'shell', 'rm', '-f', remote], { timeout: 2000 }).catch(() => {});
  }
}
