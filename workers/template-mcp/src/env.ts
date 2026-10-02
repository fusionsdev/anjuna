declare global {
  namespace Cloudflare {
    interface Env {
      /** Factory D1: builder_keys, builder_key_usage, template_fingerprints, brands, templates. */
      FACTORY: D1Database;
      MCP_OBJECT: DurableObjectNamespace;
      /** Optional read-only GitHub token (secret) so check_github_repo can read private repos. */
      GITHUB_TOKEN?: string;
      /** Requests per key per minute (default 60). */
      RATE_LIMIT_PER_MINUTE?: string;
      /** Similarity fail threshold 0.1-0.95 (default 0.5). */
      SIMILARITY_THRESHOLD?: string;
    }
  }
}

export type Env = Cloudflare.Env;
