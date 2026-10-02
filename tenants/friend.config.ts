/**
 * Friend tenant — placeholder config. Run `bun run bootstrap --tenant friend` to provision
 * resources. Then replace every placeholder value with the real one and commit.
 *
 * Placeholder convention: `.invalid` TLD (RFC 2606 reserved) for domains that aren't set yet.
 * Replace with real values before triggering the first release deploy.
 */
import type { TenantConfig } from "./schema";

const config: TenantConfig = {
  name: "friend",
  // REPLACE: friend's Cloudflare account ID (32 hex chars, from Cloudflare dashboard).
  accountId: "00000000000000000000000000000000",
  // REPLACE: hostname of the friend's core Worker.
  coreDomain: "core.friend.invalid",
  // REPLACE: hostname of the friend's control panel Worker.
  appDomain: "app.friend.invalid",
  // REPLACE: LeadsGate affiliate ID for the friend's account.
  leadsGateAid: "REPLACE_WITH_FRIEND_AID",
  prepopBase: "https://go.personalloanpro.com/aff_c",
  // REPLACE: friend's drain (AdKit) endpoint.
  drainUrl: "https://drain.friend.invalid",
  secrets: {
    // GitHub Actions secret names in the `friend` Environment — must differ from aduplift secrets.
    cloudflareApiToken: "FRIEND_CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "FRIEND_BETTER_AUTH_SECRET",
    drainToken: "FRIEND_DRAIN_TOKEN",
    postbackTokenSalt: "FRIEND_POSTBACK_TOKEN_SALT",
  },
  // REPLACE: friend's owner login email.
  ownerEmail: "owner@friend.invalid",
};

export default config;
