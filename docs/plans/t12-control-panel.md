# T12 Control panel — plan

Status: approved by owner 2026-10-02. Linear: FUS-347 (split into T12-0, T12a and follow-ups).

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Host | `app.aduplift.ai`, separate from core. Reaches core over a Service Binding (same account). |
| 2 | Stack | React + Vite SPA plus one Worker that serves the SPA and the panel API (BFF). Same toolchain as `apps/lead-form`. |
| 3 | Outer protection | Cloudflare Access in front of `app.aduplift.ai` (owner email allowlist), configured in the dashboard. better-auth still handles roles inside. |
| 4 | UI language | Thai labels, technical terms in English (as in the prototype). |
| 5 | Users per tenant | 1 owner + 2 employees. Friend's tenant (T17): the friend is owner, with 2 employees of his own. Users are seeded per tenant from tenant config. |

## Data sources

Per ADR-0001 only core binds the `leads` D1. The panel never binds `leads`; it calls core's admin API.

| Screen | Data | Depends on |
|---|---|---|
| Login, roles, audit log | D1 `auth`, `factory.audit_log` | — |
| Brands and config | core admin API → `brand_runtime` | T6 (mocked until then) |
| Add brand + install / rollback / upgrade | factory Workflows, `installs`, `install_receipts` | T10 |
| Funnel report, alerts | Analytics Engine + D1 | T9 |
| Mailing status | `mailing_outbox` via core | T8 |

## Roles

| Action | Employee | Owner |
|---|---|---|
| View brands, funnel, alerts | yes | yes |
| Add a brand (domain + keyword) and run install | yes | yes |
| Edit keyword default | yes | yes |
| Pause / resume a brand | yes | yes |
| Roll back a brand to its previous version | yes | yes |
| Change A/B weights | no | yes |
| Change amount buckets | no | yes |
| Switch flow gate mode (`param` / `signed_cookie`) | no | yes |
| Upgrade all brands (canary first) | no | yes |
| Set LeadsGate aid, postback token, drain key, prepop base | no | yes |
| View individual leads with PII | no (aggregates only) | yes |
| Data-subject deletion | no | yes |
| Manage users | no | yes |
| View audit log | own actions | all |

Rule of thumb: employees can run the day and stop the bleeding (pause, rollback). Only the owner changes where money flows, changes every brand at once, or does anything irreversible.

Every change writes `audit_log`: actor, action, target, old value, new value, time. The check is enforced server-side in the panel API, never only in the UI. better-auth config: `defaultRole: "employee"`, `adminRoles: ["owner"]`.

## Build order

1. **T12-0 Admin API contract** in `packages/contracts`: Zod schemas and fixtures for the core admin endpoints the panel needs (list/get brand runtime, update config, pause/resume, lead aggregates, owner-only lead detail, audit entries). Core (T6) and the panel both test against these fixtures.
2. **T12a Shell + auth + Brands**: `apps/web` Worker + SPA, better-auth login, role guard, audit log, Brands list and config screen against a mock core built from the T12-0 fixtures.
3. **Parallel**: T6a/T6b build the real admin API to the same contract; the panel switches from mock to the Service Binding.
4. **Later**: install screens (after T10), funnel and alerts (after T9), mailing status (after T8).

## Out of scope for T12

Builder MCP, SMTP sending, any direct D1 `leads` binding in the panel.

## Admin API decisions (2026-10-02)

1. Core binds `factory` D1 alongside `leads` and writes `audit_log` itself right after each successful brand/config change; the panel writes audit rows only for panel-only actions such as user management.
2. Brand `form_version` stays nullable in the contract and is filled from `brand_runtime.form_version` once the install Workflow (T10) writes it.
3. Core generates a strong random postback token on rotation; it is shown once in the PATCH response and is never readable again.
4. Variant IDs remain lowercase, e.g. `lite_v1` and `full_v1`.
5. A/B weights are whole-number percentages that must sum to 100.

Follow-ups:

- T6 binds the `factory` D1 and writes `audit_log`.
- T10 adds a `brand_runtime.form_version` migration and writes it at install.
