import type { TrafficTailEvent } from "@anjuna/contracts";
import { MultiNotifier, TelegramNotifier, readNotifyConfig } from "@anjuna/insights";
import type { Env } from "../env.js";

export async function createNotifier(env: Env): Promise<MultiNotifier> {
  const { settings, host } = await readNotifyConfig(env.FACTORY);
  if (settings.telegram.enabled && !env.TELEGRAM_BOT_TOKEN) console.warn("telegram_not_configured");
  return new MultiNotifier(env.LEADS, settings, env.TELEGRAM_BOT_TOKEN ? new TelegramNotifier(env.TELEGRAM_BOT_TOKEN) : null, host);
}

/** AdsBot only; observation cannot affect the visitor response. */
export async function onTailEvent(event: TrafficTailEvent, env: Env): Promise<void> {
  if (event.user_agent_family !== "adsbot") return;
  const notifier = await createNotifier(env);
  await notifier.process({ key: `adsbot:${event.brand}`, rule: "adsbot", brand: event.brand,
    level: event.http_status !== null && event.http_status !== 200 ? "alert" : "warn",
    metric: event.http_status === null ? "1 ครั้ง · ยังไม่มีข้อมูลสถานะ HTTP" : `HTTP ${event.http_status}`,
  }, new Date(event.ts).toISOString(), 10 * 60_000);
}
