'use client';

import { FormEvent, useState } from 'react';
import { signIn } from '../lib/supabase';
import { MOCK_MODE, MOCK_PASSWORD } from '../lib/mock';
import type { Identity } from '../lib/types';

export default function Login({ onSignedIn }: { onSignedIn: (i: Identity) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await signIn(email, password));
    } catch (err) {
      setError(
        navigator.onLine
          ? err instanceof Error
            ? err.message
            : 'Sign-in failed'
          : 'First sign-in on a device needs an internet connection.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>POS sign in</h1>
        {MOCK_MODE && (
          <p className="demo-hint">
            <b>Demo mode</b> — no backend. Try{' '}
            <button type="button" onClick={() => { setEmail('cashier@dukaletu.test'); setPassword(MOCK_PASSWORD); }}>cashier</button>{' '}
            <button type="button" onClick={() => { setEmail('manager@dukaletu.test'); setPassword(MOCK_PASSWORD); }}>manager</button>{' '}
            <button type="button" onClick={() => { setEmail('owner@dukaletu.test'); setPassword(MOCK_PASSWORD); }}>owner</button>{' '}
            (password <code>{MOCK_PASSWORD}</code>)
          </p>
        )}
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
