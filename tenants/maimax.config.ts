/**
 * Maimax tenant — placeholder config. Run `bun run bootstrap --tenant maimax` to provision
 * resources. Then replace every placeholder value with the real one and commit.
 *
 * Placeholder convention: `.invalid` TLD (RFC 2606 reserved) for domains that aren't set yet.
 * Replace with real values before triggering the first release deploy.
 */
import type { TenantConfig } from "./schema";

const config: TenantConfig = {
  name: "maimax",
  // REPLACE: maimax Cloudflare account ID (32 hex chars, from Cloudflare dashboard).
  accountId: "c1a44deffd54a8ce35cb9e68abeb7b11",
  // Owner-provided hostname of the maimax core Worker.
  coreDomain: "core.maimax.fit",
  // Owner-provided hostname of the maimax control panel Worker.
  appDomain: "app.maimax.fit",
  // REPLACE: LeadsGate affiliate ID for the maimax account.
  leadsGateAid: "17244",
  prepopBase: "https://go.personalloanpro.com/aff_c",
  // maimax drain VPS (143.14.147.127) — /opt/drain/drain.mjs polls core.maimax.fit.
  drainUrl: "http://143.14.147.127",
  // REPLACE: maimax listmonk base URL once the listmonk instance is deployed.
  listmonkUrl: undefined,
  secrets: {
    // GitHub Actions secret names in the `maimax` Environment — must differ from aduplift secrets.
    cloudflareApiToken: "MAIMAX_CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "MAIMAX_BETTER_AUTH_SECRET",
    drainToken: "MAIMAX_DRAIN_TOKEN",
    postbackTokenSalt: "MAIMAX_POSTBACK_TOKEN_SALT",
  },
  // REPLACE: maimax owner login email.
  ownerEmail: "owner@maimax.fit",
  d1: {
    leads:   "e22ee9b3-1c94-4c97-ad3a-fca721910bc8",
    factory: "4d83cd96-8a12-48aa-96a0-1f97c2028dcf",
    auth:    "e60dae52-ecb6-4640-901f-e2e796364c44",
  },
};

export default config;
