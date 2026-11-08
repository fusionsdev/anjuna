import type { BotKind } from "@anjuna/contracts";
import type { CoreClient } from "./core-client.js";

export type UserAgentKind = "human" | BotKind;

const ADSBOT = /AdsBot-Google|Mediapartners-Google/i;
const GOOGLEBOT = /Googlebot|Google-InspectionTool/i;
const OTHER_BOT = /GoogleOther|\b(?:bingbot|duckduckbot|yandexbot|baiduspider|applebot|ahrefsbot|semrushbot|facebookexternalhit|crawler|spider)\b/i;

/**
 * Pure classifier. It only decides what gets logged: no response, header or status ever
 * depends on it (AGENTS.md rule 3). AdsBot is tested before Googlebot because its token
 * set is a subset of Google's crawler family.
 */
export function classifyUserAgent(ua: string | null): UserAgentKind {
  if (!ua) return "human";
  if (ADSBOT.test(ua)) return "adsbot";
  if (GOOGLEBOT.test(ua)) return "googlebot";
  if (OTHER_BOT.test(ua)) return "other-bot";
  return "human";
}

/**
 * Fire-and-forget report of a crawler hit. A human request sends nothing. Any failure is
 * swallowed: the log never changes a response and is never awaited on the request path.
 */
export async function reportBotHit(
  core: Pick<CoreClient, "botHit">,
  input: { brand_id: string; request: Request; now?: Date },
): Promise<void> {
  const kind = classifyUserAgent(input.request.headers.get("user-agent"));
  if (kind === "human") return;
  try {
    await core.botHit({
      brand_id: input.brand_id,
      kind,
      path: new URL(input.request.url).pathname.slice(0, 200),
      at: (input.now ?? new Date()).toISOString(),
    });
  } catch { /* A failed count is lost on purpose. */ }
}
