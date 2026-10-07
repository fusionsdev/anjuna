/**
 * Owner tenant (AdUplift). D1 IDs for leads + factory are in wrangler.deploy.jsonc;
 * run `bun run bootstrap --tenant aduplift` to create the auth D1 and fill in d1.auth.
 */
import type { TenantConfig } from "./schema";

const config: TenantConfig = {
  name: "aduplift",
  accountId: "6cb8500c35210800451bd9a535482850",
  coreDomain: "core.aduplift.ai",
  appDomain: "app.aduplift.ai",
  leadsGateAid: "10001",
  prepopBase: "/apply",
  brandDefaults: {
    account: "aduplift",
    formRoute: "/request",
    amountBuckets: [350, 500, 750, 1000, 1500, 1750, 2000, 3000, 3250, 4500, 5000],
    payloadVersion: "2026-01",
  },
  drainUrl: "https://drain.aduplift.ai",
  listmonkUrl: "https://mail.aduplift.ai",
  alertChannel: "alerts",
  secrets: {
    cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "BETTER_AUTH_SECRET",
    drainToken: "DRAIN_TOKEN",
    postbackTokenSalt: "POSTBACK_TOKEN_SALT",
    coreToken: "CORE_TOKEN",
  },
  ownerEmail: "owner@aduplift.ai",
  r2Templates: "anjuna-templates",
  d1: {
    leads:   "e26523d5-7215-4550-af13-0b4e9364e099",
    factory: "2eb875cb-ae24-4d06-bf15-8df306046980",
    auth:    "b75cb173-0eac-4bd6-8ef2-51a3eb80f230",
  },
};

export default config;
