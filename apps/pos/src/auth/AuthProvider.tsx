import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { initSupabase, sb } from '../lib/supabase.ts';
import { errorText, read } from '../lib/api.ts';

export interface OpenShiftInfo {
  id: string;
  status: 'OPEN' | 'PENDING_COUNT';
  registerId: string;
  registerCode: string;
  registerName: string;
  openedAt: string;
}

export interface MyContext {
  userId: string;
  hasProfile: boolean;
  active?: boolean;
  role?: 'OWNER' | 'CASHIER';
  displayName?: string;
  hasPin?: boolean;
  storeId?: string;
  storeName?: string;
  mfaVerified?: boolean;
  idleLockSeconds?: number;
  refundWindowDays?: number;
  approvalTtlSeconds?: number;
  openShift?: OpenShiftInfo | null;
  assignedStockCount?: { id: string; note: string | null; openedAt: string } | null;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'signed-out' }
  | { status: 'no-profile'; email: string }
  | { status: 'inactive' }
  | { status: 'mfa'; ctx: MyContext }
  | { status: 'ready'; ctx: MyContext; session: Session };

interface AuthApi {
  state: AuthState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const { data } = await sb().auth.getSession();
      const session = data.session;
      if (!session) {
        setState({ status: 'signed-out' });
        return;
      }
      const ctx = await read<MyContext>('my_context');
      if (!ctx.hasProfile) setState({ status: 'no-profile', email: session.user.email ?? '' });
      else if (ctx.active === false) setState({ status: 'inactive' });
      else if (ctx.role === 'OWNER' && !ctx.mfaVerified) setState({ status: 'mfa', ctx });
      else setState({ status: 'ready', ctx, session });
    } catch (e) {
      setState({ status: 'error', message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    initSupabase()
      .then((client) => {
        const { data } = client.auth.onAuthStateChange((event) => {
          // Token refreshes do not change who is signed in; avoid re-rendering the till.
          if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'MFA_CHALLENGE_VERIFIED' || event === 'USER_UPDATED') {
            void refresh();
          }
        });
        unsub = () => data.subscription.unsubscribe();
        return refresh();
      })
      .catch((e) => setState({ status: 'error', message: errorText(e) }));
    return () => unsub?.();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await sb().auth.signOut();
    setState({ status: 'signed-out' });
  }, []);

  return <Ctx.Provider value={{ state, refresh, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/** Only for components rendered when status === 'ready'. */
export function useReady() {
  const { state, refresh, signOut } = useAuth();
  if (state.status !== 'ready') throw new Error('useReady used before sign-in completed');
  return { ctx: state.ctx, session: state.session, refresh, signOut };
}
