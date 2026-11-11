import { useEffect, useState } from 'react';

export function useDeviceDiscovery(api, active) {
  const [environment, setEnvironment] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    let disposed = false, pending = false, timer;
    async function poll() {
      clearTimeout(timer);
      if (disposed || pending || document.hidden) return;
      pending = true;
      setChecking(true);
      try {
        const result = await api.call('aiui_environment_check', {});
        if (!disposed) { setEnvironment(result); setError(''); }
      } catch (failure) {
        if (!disposed) setError(failure.message);
      } finally {
        pending = false;
        if (!disposed) {
          setChecking(false);
          timer = setTimeout(poll, active ? 3000 : 10000);
        }
      }
    }
    poll();
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('focus', poll);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('focus', poll);
    };
  }, [api, active]);
  return { environment, error, checking };
}
