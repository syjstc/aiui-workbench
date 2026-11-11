function createMirrorWindowLifecycle({ windows, getSession, intervalMs = 1000 }) {
  let timer, polling = false, disposed = false;
  function changed() {
    if (disposed || !windows.size) { clearInterval(timer); timer = null; }
    else if (!timer) { timer = setInterval(() => sync(), intervalMs); timer.unref(); }
  }
  function close(serial, sessionId) {
    const entry = windows.get(serial);
    if (!entry || (sessionId && entry.sessionId !== sessionId)) return false;
    windows.delete(serial);
    if (!entry.window.isDestroyed()) entry.window.close();
    changed(); return true;
  }
  async function sync() {
    if (disposed || polling || !windows.size) return;
    polling = true;
    try {
      await Promise.all([...windows].map(async ([serial, entry]) => {
        const sessionId = entry.sessionId;
        let session;
        try { session = await getSession(serial); } catch { return; }
        // A late response for an old viewer must not close its replacement.
        if (disposed || windows.get(serial) !== entry || entry.sessionId !== sessionId) return;
        if (session?.status !== 'running' || session.id !== sessionId) close(serial, sessionId);
      }));
    } finally { polling = false; }
  }
  function dispose() { disposed = true; changed(); }
  return { close, changed, sync, dispose };
}
module.exports = { createMirrorWindowLifecycle };
