/**
 * Maimax tenant. Account, domains, LeadsGate aid and D1 ids are the real provisioned values.
 * Do not re-run `bun run bootstrap --tenant maimax`: it would overwrite the hand-edited
 * maimax wrangler configs with older templates.
 */
import type { TenantConfig } from "./schema";

const config: TenantConfig = {
  name: "maimax",
  // maimax Cloudflare account ID.
  accountId: "c1a44deffd54a8ce35cb9e68abeb7b11",
  // Owner-provided hostname of the maimax core Worker.
  coreDomain: "core.maimax.com",
  // Owner-provided hostname of the maimax control panel Worker.
  appDomain: "app.maimax.com",
  // LeadsGate affiliate ID for the maimax account.
  leadsGateAid: "17244",
  prepopBase: "/apply",
  brandDefaults: {
    account: "maimax",
    formRoute: "/request",
    amountBuckets: [350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000],
    payloadVersion: "2026-01",
  },
  // maimax drain VPS (143.14.147.127) — /opt/drain/drain.mjs polls core.maimax.com.
  drainUrl: "http://143.14.147.127",
  // maimax listmonk base URL; undefined until a listmonk instance exists.
  listmonkUrl: undefined,
  secrets: {
    // GitHub Actions secret names in the `maimax` Environment — must differ from aduplift secrets.
    cloudflareApiToken: "MAIMAX_CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "MAIMAX_BETTER_AUTH_SECRET",
    drainToken: "MAIMAX_DRAIN_TOKEN",
    postbackTokenSalt: "MAIMAX_POSTBACK_TOKEN_SALT",
    coreToken: "MAIMAX_CORE_TOKEN",
  },
  // maimax owner login email used by bootstrap seeding.
  ownerEmail: "owner@maimax.com",
  d1: {
    leads:   "e22ee9b3-1c94-4c97-ad3a-fca721910bc8",
    factory: "4d83cd96-8a12-48aa-96a0-1f97c2028dcf",
    auth:    "e60dae52-ecb6-4640-901f-e2e796364c44",
  },
};

export default config;
