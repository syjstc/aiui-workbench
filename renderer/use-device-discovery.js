import { useEffect, useRef, useState } from 'react';

export function useDeviceDiscovery(api, active) {
  const [environment, setEnvironment] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const refresh = useRef();
  useEffect(() => {
    let disposed = false, pending, timer, generation = 0;
    function poll() {
      clearTimeout(timer);
      if (disposed || document.hidden) return;
      if (pending) return pending;
      const currentGeneration = generation;
      setChecking(true);
      pending = (async () => {
        try {
          const result = await api.call('aiui_environment_check', {});
          if (!disposed && currentGeneration === generation) { setEnvironment(result); setError(''); }
        } catch (failure) {
          if (!disposed && currentGeneration === generation) setError(failure.message);
        } finally {
          pending = null;
          if (!disposed) {
            setChecking(false);
            timer = setTimeout(poll, active ? 3000 : 10000);
          }
        }
      })();
      return pending;
    }
    refresh.current = async () => { generation++; await pending; return poll(); };
    poll();
    document.addEventListener('visibilitychange', poll);
    window.addEventListener('focus', poll);
    return () => {
      disposed = true;
      refresh.current = null;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', poll);
      window.removeEventListener('focus', poll);
    };
  }, [api, active]);
  return { environment, error, checking, refresh: () => refresh.current?.() };
}
