'use client';

import dynamic from 'next/dynamic';

// Everything depends on browser-only APIs (IndexedDB, service worker), so the
// shell is client-rendered. The service worker caches the resulting assets.
const App = dynamic(() => import('../components/App'), {
  ssr: false,
  loading: () => <p className="boot">Loading…</p>,
});

export default function Page() {
  return <App />;
}
