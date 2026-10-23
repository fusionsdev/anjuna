# Panel shell design (spec 1, FUS-374)

Source: backlog and ship order in `2026-10-23-panel-backlog-and-order.md`. Tracking issue: FUS-374.

## Spec 1 design: routing, shell, design system, brand card basics

### Routing
- Replace `useState<View>` in `apps/web/src/client/App.tsx` with a `useRoute` hook on `history.pushState` + `popstate`. No new dependency.
- Paths: `/brands`, `/brands/:id`, `/funnel`, `/alerts`, `/mailing`, `/audit`, `/users`; `/` redirects to `/brands` until Spec A adds Home.
- SPA fallback already set: `apps/web/wrangler.jsonc` `not_found_handling: "single-page-application"`. Confirm `src/server/index.ts` passes non-`/api` paths to `ASSETS`.

### App shell
- `components/AppShell.tsx` (sidebar + header + main), `components/SidebarNav.tsx` (links, active state, Users owner-only, Mailing kept).
- Header: page title, environment badge (tenant name from config), user menu (email, role, sign out).
- Mobile under 768 px: sidebar becomes a drawer with a menu button.

### Design system
- `styles/tokens.css`: color, spacing, radius, shadow, type scale as CSS variables; light theme first.
- Fonts bundled with `@fontsource/inter` and `@fontsource/sarabun` (no external font request).
- Shared components in `src/client/components/`: `DataTable` (sticky header, 36 px rows, monospace ids, tabular numbers), `StatusBadge` (color + icon + text), `ConfirmDialog` (replaces `window.confirm`), `EmptyState`, `Spinner`/skeleton, `Toast`.
- Apply `ConfirmDialog` to Rollback, Recover, Pause, Upgrade-all, role change, flow gate change, token rotation.

### Domain everywhere
- `useBrandLabels()` hook builds `brand_id -> domain` from `/api/lifecycle/brands` (factory `brands.domain`) with fallback to the first `BrandSummary.hostnames` entry.
- `BrandLabel` component renders domain first, id in small monospace on hover. Use it in Brands, Funnel, Alerts, Audit, UpgradeOutcomes.

### Brand card basics
- Show domain, status badge, flow-gate label ("Keyword Param" / "Single Page Cookie"), latest install status.
- Pause/Resume button on the card (owner rules unchanged: `panel-roles.ts`), with `ConfirmDialog`.
- Remove dead `screens/Brands.tsx` wrapper.

### Tests
- Routing: deep link renders the right screen, back button, unknown path.
- `ConfirmDialog` gates each destructive action (cancel sends no request).
- `useBrandLabels` mapping and fallback.
- Existing `apps/web/test/*.ui.test.tsx` stay green after the shell swap.

