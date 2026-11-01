# apps/web — control panel (T12a)

One Worker (`anjuna-web`, `app.aduplift.ai`) serving a React + Vite SPA (static assets, `run_worker_first`) and the panel API under `/api/*`.

- **Perimeter:** none. The panel has no Cloudflare Access app; better-auth sign-in is the only gate on `/api/*`.
- **Auth:** better-auth on the `AUTH` D1, email + password, admin plugin (`defaultRole: employee`, `adminRoles: [owner]`). Sign-up is closed.
- **Roles:** enforced in the Worker with `authorize()` / `ADMIN_ROLE_TABLE` (`@anjuna/contracts`) and `src/server/panel-roles.ts` for panel-only actions. The UI only hides.
- **Core:** admin API over the `CORE` service binding; `MOCK_CORE=1` swaps in `src/server/mock-core.ts` (built from `contracts/fixtures/admin`).
- **Audit:** core writes brand/config rows; the panel writes `auth.*` and `user.*` rows to `FACTORY.audit_log`.

## Local work

```sh
# .dev.vars (gitignored)
BETTER_AUTH_SECRET=<random>
DEV_ACCESS_BYPASS=1  # local only (.dev.vars). Ignored whenever Cloudflare's edge sets a non-loopback CF-Connecting-IP, on every tenant.
MOCK_CORE=1

cp seed.users.json.example seed.users.json   # gitignored; put real emails here
bun run seed                                  # writes seed.generated.sql (gitignored)
wrangler d1 execute AUTH --local --file seed.generated.sql
```

`bun run build` builds the SPA to `dist/client`; `bun run test` runs the Worker tests (Miniflare) and the build checks.
