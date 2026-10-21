'use client';

import { useEffect, useState } from 'react';
import { startConnectivity } from '../lib/connectivity';
import { loadIdentity } from '../lib/supabase';
import type { Identity } from '../lib/types';
import Login from './Login';
import Pos from './Pos';

export default function App() {
  const [identity, setIdentity] = useState<Identity | null | undefined>(undefined);

  // Register the service worker (production only, to avoid stale dev caches).
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => {
        console.error('Service worker registration failed', e);
      });
    }
  }, []);

  // Identity is read from IndexedDB, so a cashier who signed in earlier lands
  // straight on the register even with no network.
  useEffect(() => {
    void loadIdentity().then((i) => setIdentity(i ?? null));
  }, []);

  // Start watching connectivity only once someone is signed in; the first
  // observed state triggers the initial pull-and-push.
  useEffect(() => {
    if (!identity) return;
    return startConnectivity();
  }, [identity]);

  if (identity === undefined) return <p className="boot">Loading…</p>;
  if (!identity) return <Login onSignedIn={setIdentity} />;
  return <Pos identity={identity} onSignedOut={() => setIdentity(null)} />;
}
