import { useEffect, useState } from 'react';
import { passwordSetupDone, sb } from '../lib/supabase.ts';
import { errorText } from '../lib/api.ts';
import { Banner, Button, Field, Input } from '../ui/ui.tsx';
import { useAuth } from './AuthProvider.tsx';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Shell title="Sign in">
      <p className="mb-4 text-sm text-ink-2">Use your own account. Never share a login: every sale is recorded against it.</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
          setBusy(false);
          if (error) setError(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
        }}
      >
        <Field label="Email">
          <Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        {info && <Banner tone="info">{info}</Banner>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setError(null);
            if (!email.trim()) return setError('Type your email first, then press "Forgot password".');
            const { error } = await sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/` });
            if (error) setError(error.message);
            else setInfo('If that email has an account, a reset link is on its way. Open it on this device.');
          }}
        >
          Forgot password?
        </Button>
      </form>
    </Shell>
  );
}

/** After an invite or reset link: the user chooses their password. */
export function SetPassword({ email, kind }: { email: string; kind: 'invite' | 'recovery' }) {
  const { refresh, signOut } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Shell title={kind === 'invite' ? 'Welcome — choose your password' : 'Choose a new password'}>
      <p className="mb-4 text-sm text-ink-2">Account: <strong>{email}</strong>. Use at least 10 characters and do not share it.</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.length < 10) return setError('Use at least 10 characters.');
          if (pw !== pw2) return setError('The two passwords do not match.');
          setBusy(true);
          setError(null);
          const { error } = await sb().auth.updateUser({ password: pw });
          setBusy(false);
          if (error) return setError(error.message);
          passwordSetupDone();
          window.history.replaceState(null, '', '/');
          await refresh();
        }}
      >
        <Field label="New password">
          <Input type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        </Field>
        <Field label="Repeat password">
          <Input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</Button>
        <Button variant="ghost" onClick={() => { passwordSetupDone(); void signOut(); }}>Cancel</Button>
      </form>
    </Shell>
  );
}

/** Owners must verify a TOTP code each session (aal2); first time, they enrol. */
export function MfaGate() {
  const { refresh, signOut } = useAuth();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await sb().auth.mfa.listFactors();
        if (error) throw error;
        const verified = data.totp[0];
        if (verified) {
          setFactorId(verified.id);
          return;
        }
        // Remove half-finished enrolments, then start a fresh one.
        for (const f of data.all.filter((x) => x.status === 'unverified')) {
          await sb().auth.mfa.unenroll({ factorId: f.id });
        }
        const enrolled = await sb().auth.mfa.enroll({ factorType: 'totp', friendlyName: `Shop POS ${new Date().toISOString().slice(0, 10)}` });
        if (enrolled.error) throw enrolled.error;
        setFactorId(enrolled.data.id);
        setQr(enrolled.data.totp.qr_code);
        setSecret(enrolled.data.totp.secret);
      } catch (e) {
        setError(errorText(e));
      }
    })();
  }, []);

  return (
    <Shell title="Owner verification">
      {qr ? (
        <div className="mb-4 flex flex-col items-center gap-2 text-sm text-ink-2">
          <p>Scan this with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy), then enter the 6-digit code.</p>
          <img src={qr} alt="Authenticator QR code" className="h-48 w-48 rounded bg-white p-2" />
          {secret && <p className="break-all text-xs">Or type this key: <code>{secret}</code></p>}
        </div>
      ) : (
        <p className="mb-4 text-sm text-ink-2">Enter the 6-digit code from your authenticator app.</p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!factorId) return;
          setBusy(true);
          setError(null);
          const { error } = await sb().auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
          setBusy(false);
          if (error) setError('That code did not work. Check the time on your phone and try the newest code.');
          else await refresh();
        }}
      >
        <Field label="Code">
          <Input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <Button variant="primary" type="submit" disabled={busy || !factorId}>Verify</Button>
        <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
      </form>
    </Shell>
  );
}

export function Message({ title, children, retry }: { title: string; children: React.ReactNode; retry?: boolean }) {
  const { signOut } = useAuth();
  return (
    <Shell title={title}>
      <div className="mb-4 text-sm text-ink-2">{children}</div>
      {retry
        ? <Button onClick={() => window.location.reload()}>Try again</Button>
        : <Button onClick={() => void signOut()}>Sign out</Button>}
    </Shell>
  );
}
