import type { NotificationMessage } from "./format.js";

export interface DeliveryResult { status: "sent" | "failed"; response_code: number | null }
export interface NotificationChannel { send(target: string, message: NotificationMessage): Promise<DeliveryResult> }
export class TelegramNotifier implements NotificationChannel {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms))) {}

  async send(target: string, message: NotificationMessage): Promise<DeliveryResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ chat_id: target, text: message.text, parse_mode: "HTML", disable_web_page_preview: true,
            reply_markup: { inline_keyboard: [[{ text: "เปิดใน panel", url: message.url }]] } }),
        });
        const body = await response.json().catch(() => null) as { ok?: boolean; parameters?: { retry_after?: number } } | null;
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          const seconds = body?.parameters?.retry_after;
          await this.sleep(response.status === 429 && typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
          continue;
        }
        return { status: response.ok && body?.ok === true ? "sent" : "failed", response_code: response.status };
      } catch {
        // Never expose an exception: fetch errors can include the token-bearing URL.
        return { status: "failed", response_code: null };
      }
    }
    return { status: "failed", response_code: null };
  }
}
