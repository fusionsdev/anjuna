/**
 * Notification channels (owner only): the Telegram chat ids, the rule matrix and the daily digest.
 * GET and PUT /api/settings/notify hold one document. POST /api/settings/notify/test sends a test message to the saved chat ids.
 * A rule with no entry in `routing` uses the sender's default (Telegram on, repeat every 6 hours, no quiet hours), so only a rule
 * the owner changed is written back.
 */
import type { NotifySettings as Settings } from "@anjuna/contracts";
import { Hourglass, MessageCircle, Plus, Save, Send, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { Chip } from "../components/Chip";
import { Spinner } from "../components/Spinner";
import "./NotifySettings.css";

type Route = Settings["routing"][string];
type TestResult = { kind: "sent" | "failed" | "error"; text: string };

const DEFAULT_ROUTE: Route = { telegram: true, repeat_hours: 6, quiet: null };
const DEFAULT_QUIET = { from: "22:00", to: "07:00" };
const MAX_CHAT_IDS = 20;
const CHAT_ID = /^-?\d+$/;

/** The rules the alert sender knows (packages/insights notify RULES), in the order of the Alerts page. */
const RULE_LABELS: Record<string, string> = {
  conversion_stalled: "คอนเวอร์ชันส่งไม่ได้",
  brands_without_postbacks: "แบรนด์ไม่มีผลจากผู้ซื้อ",
  submit_error_rate: "อัตราส่งฟอร์มไม่สำเร็จสูง",
  reject_rate: "อัตราปฏิเสธสูง",
  click_risk: "คลิกที่จ่ายไม่มี gclid",
};

const REPEAT_OPTIONS = [1, 6, 24] as const;
const clock = (iso: Date) => iso.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
const same = (a: Settings, b: Settings) => JSON.stringify(a) === JSON.stringify(b);

export function NotifySettingsScreen() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadError(null);
    api.notifySettings().then(
      (settings) => { if (active) { setSaved(settings); setDraft(settings); } },
      (e: unknown) => { if (active) setLoadError(e instanceof ApiError ? e.thai : "โหลดการตั้งค่าแจ้งเตือนไม่สำเร็จ"); },
    );
    return () => { active = false; };
  }, [reload]);

  if (loadError) {
    return <div className="notify-page"><NotifyHead />
      <div className="note neg notify-error" role="alert" style={{ background: "var(--badbg)", color: "var(--bad)" }}>
        <p>{loadError}</p>
        <button type="button" className="btn" onClick={() => setReload((n) => n + 1)}>ลองอีกครั้ง</button>
      </div></div>;
  }
  if (!saved || !draft) return <div className="notify-page"><NotifyHead /><Spinner /></div>;

  const dirty = !same(saved, draft);
  const routeOf = (rule: string): Route => draft.routing[rule] ?? DEFAULT_ROUTE;
  const ruleKeys = [...Object.keys(RULE_LABELS), ...Object.keys(draft.routing).filter((key) => !(key in RULE_LABELS))];
  const setRoute = (rule: string, patch: Partial<Route>) => setDraft({ ...draft, routing: { ...draft.routing, [rule]: { ...routeOf(rule), ...patch } } });
  const chatIds = draft.telegram.chat_ids;
  const canTest = !dirty && saved.telegram.enabled && saved.telegram.chat_ids.length > 0;

  function addChat() {
    const id = chatInput.trim();
    if (!CHAT_ID.test(id)) return setChatError("chat id เป็นตัวเลข ขึ้นต้นด้วย - ได้ เช่น -1001842507");
    if (chatIds.includes(id)) return setChatError("มี chat id นี้แล้ว");
    if (chatIds.length >= MAX_CHAT_IDS) return setChatError(`ใส่ได้สูงสุด ${MAX_CHAT_IDS} chat id`);
    setChatError(null);
    setChatInput("");
    setDraft({ ...draft!, telegram: { ...draft!.telegram, chat_ids: [...chatIds, id] } });
  }

  async function save() {
    setSaving(true);
    setSaveState(null);
    try {
      const sent = draft!;
      const next = await api.putNotifySettings(sent);
      setSaved(next);
      // The response replaces the draft only while the draft is still what was sent. A change made after the request left stays
      // in the draft and shows as unsaved against the new saved copy. The controls are also locked while saving.
      setDraft((current) => (current && same(current, sent) ? next : current));
      setTest(null);
      setSaveState({ kind: "ok", text: "บันทึกแล้ว" });
    } catch (e) {
      setSaveState({ kind: "err", text: e instanceof ApiError ? e.thai : "บันทึกไม่สำเร็จ" });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testNotify();
      const at = clock(new Date());
      setTest(r.status === "sent"
        ? { kind: "sent", text: `ส่งแล้ว ${at} · ${r.response_code ?? "-"}` }
        : { kind: "failed", text: `ส่งไม่สำเร็จ ${at} · ${r.response_code ?? "ไม่มีรหัสตอบกลับ"}` });
    } catch (e) {
      setTest({ kind: "error", text: e instanceof ApiError && e.status === 502 ? "ติดต่อระบบส่งแจ้งเตือนไม่ได้" : e instanceof ApiError ? e.thai : "ทดสอบไม่สำเร็จ" });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="notify-page">
      <NotifyHead />
      {/* Every control is locked while the save runs, so no edit can be lost to the response. */}
      <fieldset className="notify-fields" disabled={saving}>

      <section className="panel notify-card" aria-label="Telegram">
        <header className="notify-card-head">
          <h2><Send aria-hidden="true" size={18} />Telegram</h2>
          <Chip tone={saved.telegram.enabled ? "success" : "neutral"} dot>{saved.telegram.enabled ? "เปิดอยู่" : "ปิดอยู่"}</Chip>
        </header>
        <p className="hint">Bot token ตั้งเป็น secret ของ Worker ไม่เก็บในหน้านี้</p>
        <label className="notify-switch">
          <input type="checkbox" role="switch" aria-label="เปิดแจ้งเตือนผ่าน Telegram" checked={draft.telegram.enabled}
            onChange={(e) => setDraft({ ...draft, telegram: { ...draft.telegram, enabled: e.target.checked } })} />
          เปิดแจ้งเตือนผ่าน Telegram
        </label>
        <ul className="notify-chats" aria-label="chat id ที่รับแจ้งเตือน">
          {chatIds.length === 0 && <li className="hint">ยังไม่มี chat id</li>}
          {chatIds.map((id) => (
            <li key={id}>
              <span className="mono">{id}</span>
              <button type="button" className="btn ghost notify-icon-btn" aria-label={`ลบ chat id ${id}`}
                onClick={() => setDraft({ ...draft, telegram: { ...draft.telegram, chat_ids: chatIds.filter((x) => x !== id) } })}>
                <X aria-hidden="true" size={16} />
              </button>
            </li>
          ))}
        </ul>
        <div className="notify-add">
          <input className="mono" aria-label="chat id ใหม่" placeholder="เพิ่ม chat id" inputMode="numeric" value={chatInput} aria-invalid={chatError ? true : undefined}
            onChange={(e) => { setChatInput(e.target.value); setChatError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChat(); } }} />
          <button type="button" className="btn" disabled={chatInput.trim() === ""} onClick={addChat}><Plus aria-hidden="true" size={16} />เพิ่ม chat id</button>
        </div>
        {chatError && <p className="neg" role="alert">{chatError}</p>}
        <div className="notify-test">
          <button type="button" className="btn pri" disabled={!canTest || testing} onClick={() => void sendTest()}>
            <Send aria-hidden="true" size={16} />{testing ? "กำลังส่ง…" : "ส่งข้อความทดสอบ"}
          </button>
          {test && <span role="status" className={test.kind === "sent" ? "notify-result pos" : "notify-result neg"}>{test.text}</span>}
          {!canTest && <span className="hint">{dirty ? "บันทึกก่อน แล้วจึงทดสอบ" : "เปิด Telegram และใส่ chat id ก่อนทดสอบ"}</span>}
        </div>
      </section>

      <section className="panel notify-card notify-muted" aria-label="LINE" aria-disabled="true">
        <header className="notify-card-head">
          <h2><MessageCircle aria-hidden="true" size={18} />LINE</h2>
          <Chip tone="neutral"><Hourglass aria-hidden="true" />เร็ว ๆ นี้</Chip>
        </header>
        <p className="hint">ต้องมี LINE Official Account และ Messaging API channel</p>
      </section>

      <section className="panel notify-card" aria-label="กฎที่ส่ง">
        <header className="notify-card-head"><h2>กฎที่ส่ง</h2></header>
        <div className="notify-table-wrap">
          <table className="notify-rules">
            <thead>
              <tr><th>กฎ</th><th>Telegram</th><th>ส่งซ้ำทุก</th><th>ช่วงเงียบ</th></tr>
            </thead>
            <tbody>
              {ruleKeys.map((rule) => {
                const route = routeOf(rule);
                const label = RULE_LABELS[rule] ?? rule;
                return (
                  <tr key={rule}>
                    <td data-label="กฎ">{label}</td>
                    <td data-label="Telegram">
                      <input type="checkbox" aria-label={`ส่ง ${label} ผ่าน Telegram`} checked={route.telegram} onChange={(e) => setRoute(rule, { telegram: e.target.checked })} />
                    </td>
                    <td data-label="ส่งซ้ำทุก">
                      <select aria-label={`ส่ง ${label} ซ้ำทุก`} value={route.repeat_hours}
                        onChange={(e) => setRoute(rule, { repeat_hours: Number(e.target.value) as Route["repeat_hours"] })}>
                        {REPEAT_OPTIONS.map((h) => <option key={h} value={h}>{h} ชม.</option>)}
                      </select>
                    </td>
                    <td data-label="ช่วงเงียบ">
                      <div className="notify-quiet">
                        <label className="notify-switch">
                          <input type="checkbox" aria-label={`ตั้งช่วงเงียบของ ${label}`} checked={route.quiet !== null}
                            onChange={(e) => setRoute(rule, { quiet: e.target.checked ? DEFAULT_QUIET : null })} />
                          {route.quiet ? "" : "ไม่ตั้ง"}
                        </label>
                        {route.quiet && <>
                          <input type="time" aria-label={`ช่วงเงียบของ ${label} เริ่ม`} value={route.quiet.from} onChange={(e) => e.target.value && setRoute(rule, { quiet: { ...route.quiet!, from: e.target.value } })} />
                          <span aria-hidden="true">ถึง</span>
                          <input type="time" aria-label={`ช่วงเงียบของ ${label} สิ้นสุด`} value={route.quiet.to} onChange={(e) => e.target.value && setRoute(rule, { quiet: { ...route.quiet!, to: e.target.value } })} />
                        </>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">เวลาช่วงเงียบเป็นเวลากรุงเทพ กฎที่ไม่ได้แก้ใช้ค่าเริ่มต้น: เปิด Telegram ส่งซ้ำทุก 6 ชม. ไม่มีช่วงเงียบ</p>
      </section>

      <section className="panel notify-card" aria-label="สรุปรายวัน">
        <header className="notify-card-head"><h2>สรุปรายวัน</h2></header>
        <div className="notify-digest">
          <label className="notify-switch">
            <input type="checkbox" role="switch" aria-label="เปิดสรุปรายวัน" checked={draft.digest.enabled}
              onChange={(e) => setDraft({ ...draft, digest: { ...draft.digest, enabled: e.target.checked } })} />
            เปิดสรุปรายวัน
          </label>
          <label>เวลาส่ง
            <input type="time" aria-label="เวลาส่งสรุปรายวัน" value={draft.digest.time} disabled={!draft.digest.enabled}
              onChange={(e) => e.target.value && setDraft({ ...draft, digest: { ...draft.digest, time: e.target.value } })} />
          </label>
        </div>
        <p className="hint">ส่งค่าโฆษณา ลีด ต้นทุนต่อลีด ขายได้ กำไร และเรื่องที่ต้องแก้ ตามเวลากรุงเทพ</p>
      </section>
      </fieldset>

      <div className="notify-save">
        <button type="button" className="btn pri" disabled={!dirty || saving} onClick={() => void save()}><Save aria-hidden="true" size={16} />{saving ? "กำลังบันทึก…" : "บันทึก"}</button>
        {dirty && <button type="button" className="btn" disabled={saving} onClick={() => { setDraft(saved); setChatError(null); setSaveState(null); }}>ยกเลิกการแก้ไข</button>}
        {saveState && <span role={saveState.kind === "ok" ? "status" : "alert"} className={saveState.kind === "ok" ? "notify-result pos" : "notify-result neg"}>{saveState.text}</span>}
        {dirty && !saveState && <span className="hint">มีการแก้ไขที่ยังไม่บันทึก</span>}
      </div>
    </div>
  );
}

function NotifyHead() {
  return (
    <div className="head">
      <div>
        <h1>ช่องทางแจ้งเตือน</h1>
        <p className="sub">เลือกช่องทาง กฎที่ส่ง และสรุปรายวัน เฉพาะ Owner</p>
      </div>
    </div>
  );
}
