// Only completed device syncs with matching membership are usable. A remote
// listing can include agents whose package is still waiting to download.
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][\w.-]{0,220}$/.test(value)
  && !/^(?:develop|builtin)\./i.test(value);
const field = value => typeof value === 'string' ? value : '';

function storeApp(agentId, item = {}) {
  return {
    agentId, name: field(item.agentName) || agentId, version: field(item.nativeVersion),
    description: field(item.agentDesc).slice(0, 12000), engine: field(item.inkVersion),
    permissions: Array.isArray(item.permissions) ? item.permissions.filter(p => typeof p === 'string' && p) : [],
    kind: 'aiui', source: 'store', readOnly: true, removable: false, localProject: null,
  };
}

export function providerStoreApps(output) {
  const apps = new Map();
  for (const line of output.trim().split(/\r?\n/)) {
    const row = /^Row: \d+ (.+)$/.exec(line);
    if (!row) return null;
    const fields = Object.fromEntries(row[1].split(/, (?=\w+=)/).map(pair => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }));
    const agentId = fields.agent_id ?? fields.agentId;
    if (!['REMOTE','REMOTE_SYNC'].includes(fields.package_strategy ?? fields.strategy) || !validId(agentId)) continue;
    const app = storeApp(agentId, {agentName: fields.agent_name, nativeVersion: fields.native_version});
    apps.set(agentId, {...app, bytes: /^\d+$/.test(fields._size) ? Number(fields._size) : null});
  }
  // The package provider on some firmware resolves individual package URIs.
  // An empty cursor at its root is not evidence of an empty inventory.
  return apps.size ? [...apps.values()] : null;
}

function responseMetadata(body) {
  // Android can truncate a log entry mid-string. Only finished objects and
  // the leading identifier/name pair of an unfinished record are eligible.
  const prefix = /^\{"code":1,.*?"data":\[/.exec(body);
  if (!prefix) return [];
  const items = [];
  let start = prefix[0].length;
  let depth = 0, quoted = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (quoted && ch === '\\') { i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) {
      try { items.push(JSON.parse(body.slice(start, i + 1))); } catch { break; }
      if (body[i + 1] !== ',') return items;
      start = i + 2;
    }
  }
  const head = /^\{"agentId":("(?:[^"\\]|\\.)*"),"agentName":("(?:[^"\\]|\\.)*"),/.exec(body.slice(start));
  if (head) {
    try { items.push({agentId: JSON.parse(head[1]), agentName: JSON.parse(head[2])}); } catch {}
  }
  return items;
}

export function lastStoreSync(output) {
  let metadata = new Map(), batch, snapshot;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d{9,11}\.\d+)\s+(\d+)\s+(\d+)\s+\w\s+(?:AssistServer_Log\s*:\s*(AIUI_\w+) -> |(AIUI_\w+)\s*:\s*)(.*)$/.exec(line);
    if (!match) continue;
    const [, seconds, pid, tid, wrapperTag, directTag, message] = match;
    const tag = wrapperTag || directTag;
    const key = pid + ':' + tid;
    if (tag === 'AIUI_JsaiAiuiHostProvider' && message.startsWith('fetchAndSyncNativeAgentList response body=')) {
      metadata = new Map(responseMetadata(message.slice(message.indexOf('=') + 1)).map(item => [item.agentId, item]));
      continue;
    }
    if (tag !== 'AIUI_AgentAppManager') continue;
    const start = /^syncAgentList start incomingSize=(\d+)$/.exec(message);
    if (start) {
      batch = {key, count: Number(start[1]), ids: new Set(), apps: [], metadata};
      metadata = new Map();
      snapshot = null;
      continue;
    }
    if (!batch || key !== batch.key) continue;
    const item = /^syncAgentList agentId=(\S+) shouldDownload=(true|false) urlBlank=(true|false)(?:\s|$)/.exec(message);
    if (item) {
      const [, id, shouldDownload, blank] = item;
      if (batch.ids.has(id)) { batch = null; continue; }
      batch.ids.add(id);
      if (validId(id) && shouldDownload === 'false' && blank === 'false') {
        batch.apps.push(storeApp(id, batch.metadata.get(id)));
      }
    } else if (message.startsWith('syncAgentList complete incomingSize=')) {
      if (message === 'syncAgentList complete incomingSize=' + batch.count && batch.ids.size === batch.count) {
        snapshot = {apps: batch.apps, observedAt: new Date(Number(seconds) * 1000).toISOString()};
      }
      batch = null;
    } else if (/failed|rejected|stale/i.test(message)) {
      batch = null;
    }
  }
  return snapshot || null;
}

// A phone refresh can deliver individual updates without emitting a sync
// batch. The host also reports successful presentations with explicit origin.
export function deviceStoreRecords(output) {
  const snapshot = lastStoreSync(output);
  const syncedAt = snapshot?.observedAt;
  const records = new Map((snapshot?.apps || []).map(app => [app.agentId, {...app, syncedAt}]));
  for (const line of output.split(/\r?\n/)) {
    const header = /^\s*(\d{9,11}\.\d+)\s+\d+\s+\d+\s+\w\s+(\w+)\s*:\s*(.*)$/.exec(line);
    if (!header) continue;
    const [, seconds, tag, message] = header;
    const observedAt = new Date(Number(seconds) * 1000).toISOString();
    if (syncedAt && observedAt <= syncedAt) continue;
    if (tag === 'AssistServer_Log') {
      const removal = /^JsaiCmdHelper -> handleRemoveNativeAgent dispatch agentId=([\w.-]+)(?:\s|$)/.exec(message);
      if (removal) records.delete(removal[1]);
      continue;
    }
    if (tag !== 'AIUI_AiuiRuntimeCoordinator' || !message.startsWith('[AIUI] event=presentation_result ')) continue;
    const fields = Object.fromEntries([...message.matchAll(/(?:^|\s)(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
    if (fields.package_strategy !== 'REMOTE_SYNC' || fields.outcome !== 'COMMITTED' ||
        fields.open_target !== 'AGENT' || !validId(fields.agent_id)) continue;
    const app = records.get(fields.agent_id) || storeApp(fields.agent_id);
    records.set(app.agentId, {...app, lastOpenedAt: observedAt});
  }
  const apps = [...records.values()];
  if (apps.some(app => !app.syncedAt)) return {apps, status:'observed', evidence:'device-activity'};
  if (snapshot) return {apps, status:'snapshot', evidence:'device-sync', observedAt:syncedAt};
  return null;
}

export async function readStoreCatalog(glasses, serial, hostPackage, provider) {
  const source = {source: 'store', readOnly: true, hostPackage, provider, complete: false, count: null};
  let reason = 'not-supported';
  try {
    const {stdout, stderr} = await glasses.adbCommand(serial, ['shell','content','query','--uri',provider], {timeout:10000, maxBytes:2*1024*1024});
    if (/Permission Denial|ACCESS_AIUI_PACKAGES|SecurityException/.test(stdout.toString() + stderr)) reason = 'permission-denied';
    else if (!stderr?.trim()) {
      const apps = providerStoreApps(stdout.toString());
      if (apps) return {apps, source: {...source, status:'partial', evidence:'package-provider', visibleCount:apps.length}};
    }
  } catch (error) {
    if (/Permission Denial|ACCESS_AIUI_PACKAGES|SecurityException/.test(error.message)) reason = 'permission-denied';
  }
  try {
    const pid = (await glasses.shell(serial, ['pidof', hostPackage])).trim();
    if (/^\d+$/.test(pid)) {
      const args = ['logcat', '-b', 'main', '-d', '-v', 'threadtime', '-v', 'epoch', '--pid', pid,
        '-e', '^(AIUI_[A-Za-z]+ -> )?(syncAgentList |fetchAndSyncNativeAgentList response body=)|^JsaiCmdHelper -> handleRemoveNativeAgent dispatch |^\\[AIUI\\] event=presentation_result ',
        'AssistServer_Log:D', 'AIUI_AgentAppManager:D', 'AIUI_JsaiAiuiHostProvider:D', 'AIUI_AiuiRuntimeCoordinator:I', '*:S'];
      const result = deviceStoreRecords(await glasses.shell(serial, args, {timeout:10000, maxBytes:4*1024*1024}));
      if (result) {
        const {apps, ...evidence} = result;
        return {apps, source:{...source, ...evidence, visibleCount:apps.length}};
      }
    }
  } catch { /* A missing diagnostic buffer leaves the installed count unknown. */ }
  return {apps:[], source:{...source, status:'unavailable', reason}};
}
