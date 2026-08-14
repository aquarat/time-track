import { useCallback, useEffect, useState } from 'react';

/**
 * Minimal history router. Three routes do not justify a routing dependency.
 */
export function useRoute(): [string, (path: string) => void] {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return [path, navigate];
}
