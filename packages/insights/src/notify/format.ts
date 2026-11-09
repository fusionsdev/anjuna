export interface Notice { key: string; rule: string; brand: string; level: "ok" | "warn" | "alert"; metric: string }
export interface NotificationMessage { text: string; url: string }
export interface DigestNumbers { spend: number; leads: number; cpl: number; sold: number; profit: number; top_fix: string }
export const RULE_TEXT: Record<string, string> = {
  conversion_stalled: "คอนเวอร์ชันค้าง", brands_without_postbacks: "ยังไม่มีผลตอบกลับ", submit_error_rate: "ส่งฟอร์มผิดพลาด",
  reject_rate: "อัตราปฏิเสธสูง", click_risk: "ทราฟฟิกน่าสงสัย", adsbot: "AdsBot เข้าชม", digest: "สรุปประจำวัน",
};
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const bangkokTime = (at: string) => new Date(Date.parse(at) + 7 * 3_600_000).toISOString().slice(11, 16);
export const panelHost = (value: unknown) => typeof value === "string" && /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(value) ? value : "app.aduplift.ai";
export function formatNotice(notice: Notice, at: string, host = "app.aduplift.ai"): NotificationMessage {
  return { text: `${notice.level === "alert" ? "🔴" : "🟠"} ${escape(RULE_TEXT[notice.rule] ?? "แจ้งเตือนระบบ")} · ${escape(notice.brand)}\n${escape(notice.metric)}\nตรวจพบ ${bangkokTime(at)}`,
    url: `https://${panelHost(host)}/alerts?key=${encodeURIComponent(notice.key)}` };
}
export function formatDigest(values: DigestNumbers, at: string, host: string): NotificationMessage {
  return { text: `🟠 สรุปประจำวัน\nค่าโฆษณา $${values.spend.toFixed(2)} · ลีด ${values.leads} · CPL $${values.cpl.toFixed(2)}\nขายได้ ${values.sold} · กำไร $${values.profit.toFixed(2)}\nต้องแก้: ${escape(values.top_fix)}\nตรวจพบ ${bangkokTime(at)}`,
    url: `https://${panelHost(host)}/alerts` };
}
