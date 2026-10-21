# Duka-tetu — offline-first, single-database multi-tenant

```
 Cashier device (PWA, Vercel)                    Railway (1 container)          Supabase
┌───────────────────────────────┐   HTTPS/JSON   ┌───────────────────┐   SQL   ┌──────────────────┐
│ Next.js + Service Worker      │ ─────────────► │ Fastify           │ ──────► │ Postgres + RLS   │
│ Dexie/IndexedDB (replica +    │  POST /v1/sync │  • verify JWT     │  as the │ shared tables,   │
│   outbox, card attempts)      │ ◄───────────── │  • verify Stripe  │ caller  │ tenant_id on all │
│ Stripe Terminal JS SDK ───────┼─► Stripe cloud │  • set RLS claims │         │ Auth (JWT + hook)│
└───────────────────────────────┘                └───────────────────┘         └──────────────────┘
```

| Path | What it is |
|---|---|
| `supabase/migrations/0001_init.sql` | Schema, RLS policies, JWT claim helpers, Custom Access Token Hook |
| `supabase/seed.sql` | Demo tenant + products |
| `apps/api` | Fastify API: `/v1/sync`, `/v1/terminal/*`, `/healthz`, `/readyz` |
| `apps/web` | Next.js PWA: service worker, Dexie, sync engine, Stripe Terminal JS |
| `apps/mobile` | Expo/React Native Android app: native register, SQLite outbox, reconnect sync |

## How the requirements are met

- **Offline-first PWA.** `public/sw.js` precaches the shell and cache-first serves `/_next/static/*`; all business data is in IndexedDB (Dexie). Cash sales are written to the local outbox in one transaction and work with no network. The signed-in identity is cached locally so a shift survives token expiry.
- **Single database, multi-tenant, RLS.** Every table has `tenant_id`; policies compare it to `app.tenant_id()`, read from the verified JWT claim. The API runs each request as `set local role authenticated` (no `bypassrls`) after setting `request.jwt.claims`, and tables use `FORCE ROW LEVEL SECURITY`. Tenant ids are never taken from request bodies. `anon` has no table privileges.
- **One lightweight container.** Fastify on Railway, no queues/workers/caches. Stateless; scale by replicas if ever needed.
- **Stripe Terminal JS only.** No drivers or native bridges. The server only mints connection tokens and creates `card_present` PaymentIntents (tenant + sale id in metadata).
- **Pull-and-push batch sync on connectivity change only.** `lib/connectivity.ts` fires on `unknown→online` (launch) and `offline→online`; there is no timer and no per-sale trigger. One `POST /v1/sync` pushes up to 50 outbox sales and pulls per-table cursor pages. Push is idempotent (client UUIDs + `ON CONFLICT DO NOTHING`), card payments are re-verified against Stripe server-side, and rejected sales stay visible on the device with a reason.

## Setup

### 1. Supabase
1. Run `supabase/migrations/0001_init.sql` in the SQL editor.
2. Authentication → Hooks → enable **Custom Access Token** → `public.custom_access_token_hook`.
3. Create a user, edit the email in `supabase/seed.sql`, run it.
4. Settings → API: do not expose these tables through the Data API (the migration already revokes `anon`).

### 2. Stripe (test mode first)
Create a Terminal **Location**, register a reader (or use the simulated one), and note the `tml_…` id.

### 3. API → Railway
Service root directory `apps/api` (uses its `Dockerfile` and `railway.json`). Set the variables from `apps/api/.env.example`. Use the Supabase **session-mode pooler** string if Railway can't reach Supabase over IPv6. Health check: `/healthz`.

### 4. Web → Vercel
Project root directory `apps/web`. Set `NEXT_PUBLIC_*` from `apps/web/.env.example`, then add your Vercel domain to the API's `WEB_ORIGINS`.

### Local dev
```
npm run install:all
cp apps/api/.env.example apps/api/.env   # fill in
cp apps/web/.env.example apps/web/.env.local
npm run dev:api   # :3000
npm run dev:web   # use another port, e.g. PORT=3001
```
The service worker registers only in production builds (`next build && next start`) — test offline mode there, not in `next dev`.

## Native Android app
The Expo app is in `apps/mobile` and shares Supabase authentication and the Fastify `/v1/sync` contract with the PWA. Cash sales are committed locally to SQLite before they are shown as complete, then pushed on reconnect or when the cashier taps **Sync now**.

1. Copy `apps/mobile/.env.example` to `apps/mobile/.env` and set the public Supabase URL/anon key and API URL.
2. Install dependencies from the mobile app directory: `npm install`.
3. Build and install on a connected Android device/emulator: `npx expo run:android`.
4. To type-check without building: `npm run typecheck`.

On Windows, Ninja's 260-character path limit can break native CMake builds in deep folders (`ninja: error: mkdir ...safeareacontext...`). The mobile app's `withWindowsCmake` config plugin selects Android SDK CMake 4.1.2 on Windows, which includes a long-path-aware Ninja. Install CMake 4.1.2 from Android Studio > SDK Manager > SDK Tools, then enable Windows long paths once from an elevated PowerShell:

```powershell
Set-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem LongPathsEnabled 1
```

After that, regenerate the Android project and use the normal command:

```powershell
npx expo prebuild --clean --platform android
npx expo run:android
```

The Windows long-path registry setting is machine-wide. The Kotlin-version, `android.newDsl` and obsolete-API lines in the Gradle log are warnings, not errors.

## Demo mode (no Supabase)
Test every feature before the backend exists. Demo mode is on whenever Supabase is not configured (or `*_MOCK_MODE=true`). Sign in as `owner@`, `manager@` or `cashier@dukaletu.test`, password `demo1234`; the login screens show tap-to-fill buttons. The catalogue is 12 demo products priced in KES.

- **API**: `npm run dev:api:mock` serves `/v1/sync` and `/v1/terminal/*` from memory on `:8787` (no Postgres, Supabase or Stripe; card payments are simulated). Data resets on restart. `MOCK_MODE` must never be enabled in production.
- **Web**: leave `NEXT_PUBLIC_SUPABASE_URL` empty. With no `NEXT_PUBLIC_API_URL` the browser answers sync itself; set it to `http://localhost:8787` to use the mock API. Card payments use a simulated reader.
- **Mobile**: leave the Supabase values unset. With no `EXPO_PUBLIC_API_URL` sync is answered on the device; set it to `http://<your-pc-ip>:8787` to use the mock API.

To go live, fill in the real values and remove the mock flags.

JavaScript Stripe Terminal is browser-only. The native register currently accepts cash; card readers remain available in the web PWA until a native Stripe Terminal integration is added.

## Decisions and limits you should know about

1. **Cards need a connection.** The Stripe Terminal JS SDK drives internet readers through Stripe's cloud; Stripe's offline card mode exists only in the iOS/Android SDKs. Offline the register takes cash and queues the sale; the Card button is disabled. This is a consequence of the "JS SDK only" requirement, not something code can paper over.
2. **Strict transition-only sync leaves a gap.** A sale rung up while already online waits in the outbox until the next transition. `SYNC_POLICY.flushOnLocalWriteWhileOnline` in `apps/web/src/lib/sync.ts` is the one-line switch if you want it pushed immediately. There is also a manual "Sync now" button.
3. **Charged-but-unrecorded protection.** A `card_attempts` row is written before the card is presented; on reconnect `reconcileCardAttempts()` asks Stripe for the outcome and commits the sale if it succeeded.
4. **Sign-out is blocked while sales are unsynced**, because it wipes the local replica.
5. **Not built:** refunds/voids, product editing UI (catalog is pulled; the API/RLS already permit manager writes), receipts/printing, per-tenant Stripe accounts (Connect), tenant switcher (users get their oldest membership), CSP headers, Stripe webhooks.
6. **Price trust:** the server checks arithmetic, totals, currency and Stripe amounts, but does not re-price lines against the catalog, since offline prices can legitimately lag.
7. **Cache growth:** `pos-assets-*` is never pruned between deploys of the same `VERSION`; bump `VERSION` in `sw.js` periodically.

## Verification status

Mobile dependencies are locked in `apps/mobile/package-lock.json`. The Expo SDK requires Node 22.13+ or 24.3+; Android builds also require Java 17 and an installed Android SDK. In this environment, the mobile TypeScript check, Android bundle export, and debug APK build passed from a short Windows path. `npx expo run:android` additionally needs a responsive ADB server and a connected device/emulator to install and launch the APK.
