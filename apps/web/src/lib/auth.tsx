import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface User {
  id: string;
  email: string;
  name: string | null;
  role: 'ADMIN' | 'USER';
  walletNetwork: string | null;
  walletAddress: string | null;
  locale: 'ru' | 'en';
  theme: 'SYSTEM' | 'LIGHT' | 'DARK';
}

interface AuthValue {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (name: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ user: User }>('/api/auth/me');
      setUser(result.user);
    } catch { setUser(null); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const value = useMemo<AuthValue>(() => ({
    user, loading, refresh,
    login: async (email, password) => {
      const result = await api<{ user: User }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      setUser(result.user);
    },
    register: async (name, email, password) => {
      const result = await api<{ user: User }>('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
      setUser(result.user);
    },
    logout: async () => { await api('/api/auth/logout', { method: 'POST' }); setUser(null); },
  }), [user, loading, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}
