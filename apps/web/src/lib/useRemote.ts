import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export function useRemote<T>(loader: () => Promise<T>, dependencies: DependencyList = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const version = useRef(0);
  const reload = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loader();
      if (version.current === current) setData(result);
    } catch (cause) {
      if (version.current === current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version.current === current) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(() => {
    void reload();
    return () => { version.current++; };
  }, [reload]);
  return { data, error, loading, reload };
}
