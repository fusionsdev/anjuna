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
  prepopBase: "https://go.personalloanpro.com/aff_c",
  drainUrl: "https://drain.aduplift.ai",
  listmonkUrl: "https://mail.aduplift.ai",
  alertChannel: "alerts",
  secrets: {
    cloudflareApiToken: "CLOUDFLARE_API_TOKEN",
    betterAuthSecret: "BETTER_AUTH_SECRET",
    drainToken: "DRAIN_TOKEN",
    postbackTokenSalt: "POSTBACK_TOKEN_SALT",
  },
  ownerEmail: "owner@aduplift.ai",
  r2Templates: "anjuna-templates",
};

export default config;
