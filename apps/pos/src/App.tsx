import { lazy, Suspense, useEffect } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider.tsx';
import { Login, Message, MfaGate } from './auth/Login.tsx';
import { navigate, usePath } from './lib/router.ts';
import { Spinner } from './ui/ui.tsx';

// Tills never download the owner dashboard code, and vice versa.
const TillApp = lazy(() => import('./till/TillApp.tsx').then((m) => ({ default: m.TillApp })));
const AdminApp = lazy(() => import('./admin/AdminApp.tsx').then((m) => ({ default: m.AdminApp })));

export function App() {
  return (
    <AuthProvider>
      <Root />
    </AuthProvider>
  );
}

function Root() {
  const { state } = useAuth();
  const path = usePath();

  // pos.<domain> opens the till, admin.<domain> the dashboard; otherwise by role.
  useEffect(() => {
    if (state.status !== 'ready') return;
    if (path.startsWith('/till') || path.startsWith('/admin')) {
      if (path.startsWith('/admin') && state.ctx.role !== 'OWNER') navigate('/till', true);
      return;
    }
    const host = window.location.hostname;
    const target = host.startsWith('admin.') && state.ctx.role === 'OWNER' ? '/admin'
      : host.startsWith('pos.') ? '/till'
      : state.ctx.role === 'OWNER' ? '/admin' : '/till';
    navigate(target, true);
  }, [state, path]);

  switch (state.status) {
    case 'loading':
      return <Spinner />;
    case 'error':
      return <Message title="Cannot start" retry>{state.message}</Message>;
    case 'signed-out':
      return <Login />;
    case 'no-profile':
      return (
        <Message title="Account not set up">
          {state.email} is signed in but has no staff role yet. Ask the owner to assign you a role under Staff.
        </Message>
      );
    case 'inactive':
      return <Message title="Account deactivated">This account has been deactivated. Ask the owner.</Message>;
    case 'mfa':
      return <MfaGate />;
    case 'ready':
      if (path.startsWith('/admin') && state.ctx.role === 'OWNER') return <Suspense fallback={<Spinner />}><AdminApp /></Suspense>;
      if (path.startsWith('/till')) return <Suspense fallback={<Spinner />}><TillApp /></Suspense>;
      return <Spinner />;
  }
}
