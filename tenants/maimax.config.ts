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
  accountId: "00000000000000000000000000000000",
  // Owner-provided hostname of the maimax core Worker.
  coreDomain: "core.maimax.fit",
  // Owner-provided hostname of the maimax control panel Worker.
  appDomain: "app.maimax.fit",
  // REPLACE: LeadsGate affiliate ID for the maimax account.
  leadsGateAid: "REPLACE_WITH_FRIEND_AID",
  prepopBase: "https://go.personalloanpro.com/aff_c",
  // REPLACE: maimax drain (AdKit) endpoint.
  drainUrl: "https://drain.friend.invalid",
  secrets: {
    // GitHub Actions secret names in the `maimax` Environment — must differ from aduplift secrets.
    cloudflareApiToken: "MAIMAX_CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "MAIMAX_BETTER_AUTH_SECRET",
    drainToken: "MAIMAX_DRAIN_TOKEN",
    postbackTokenSalt: "MAIMAX_POSTBACK_TOKEN_SALT",
  },
  // REPLACE: maimax owner login email.
  ownerEmail: "owner@friend.invalid",
};

export default config;
