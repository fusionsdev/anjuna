import { roleAtLeast, type PanelCampaign, type PanelCampaignsResponse } from "@anjuna/contracts";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { Chip, type ChipTone } from "../components/Chip";
import type { Tone } from "../components/StatusBadge";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import "./Campaigns.css";
import { useBrandScope } from "../useBrandScope";

type State = PanelCampaign["state"];
type Geo = PanelCampaign["geo"];

/** Thai label and tone per derived state. `enabling` covers an enable held for its cap recheck and one waiting for the VPS. */
const STATE: Record<State, { label: string; tone: Tone }> = {
  drafting: { label: "กำลังสร้างร่าง", tone: "mute" },
  draft: { label: "ร่าง", tone: "blue" },
  enabling: { label: "รอตรวจเพดานและเปิดใช้", tone: "warn" },
  enabled: { label: "ทำงาน", tone: "live" },
  paused: { label: "หยุดอยู่", tone: "mute" },
  failed: { label: "สร้างร่างไม่สำเร็จ", tone: "bad" },
  unknown: { label: "ไม่ทราบผล รอตรวจสถานะ", tone: "warn" },
  removed: { label: "ถูกลบใน Google Ads", tone: "mute" },
};
/** Only these may be enabled; enabling, enabled and unknown never offer enable again. */
const ENABLEABLE: ReadonlySet<State> = new Set(["draft", "paused"]);
const PAUSABLE: ReadonlySet<State> = new Set(["enabled", "unknown"]);

const satang = (baht: number) => Math.round(baht * 100);
const baht = (n: number) => `฿${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const account = (a: string) => (/^\d{10}$/.test(a) ? `${a.slice(0, 3)}-${a.slice(3, 6)}-${a.slice(6)}` : a);
const geoText = (geo: Geo) => ("country" in geo ? `ประเทศ ${geo.country}` : `เมือง รหัส ${geo.city_code}`);
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };

function budgetText(c: PanelCampaign): string {
  if (c.currency === "THB" || (c.currency === null && c.daily_budget_thb !== null)) return baht(c.daily_budget);
  if (c.currency === "USD") return `US$${c.daily_budget.toLocaleString("en-US", { maximumFractionDigits: 2 })}${c.daily_budget_thb !== null ? ` ≈ ${baht(c.daily_budget_thb)}` : ""}`;
  return `${c.daily_budget.toLocaleString("en-US", { maximumFractionDigits: 2 })} สกุลเงินไม่ทราบ`;
}

/**
 * Cap figures in baht per day. `brandUsed` is the committed figure core returns (spending campaigns plus pending
 * budget jobs), the same one core checks the caps with; null when core cannot convert a currency.
 */
function capsFor(data: PanelCampaignsResponse, brandId: string): { brandUsed: number | null; left: number | null } {
  const committed = data.brands.find((b) => b.brand_id === brandId)?.committed_thb_day ?? null;
  if (committed === null) return { brandUsed: null, left: null };
  const used = satang(committed);
  const brandLeft = satang(data.caps.brand_thb_day) - used;
  const totalLeft = satang(data.caps.total_thb_day) - satang(data.enabled_total_thb_day);
  return { brandUsed: used / 100, left: Math.max(0, Math.min(brandLeft, totalLeft)) / 100 };
}

const OVER_CAP = "งบต่อวันเกินเพดานที่เหลือ ลดงบ หรือให้ owner แก้เพดานในหน้าตั้งค่า";

/** A core cap refusal reads `brand_cap: ...` or `total_cap: ...`; anything else keeps the shared Thai message. */
function thaiError(e: unknown): string {
  if (!(e instanceof ApiError)) return "ไม่สำเร็จ ลองใหม่อีกครั้ง";
  const message = e.body?.error === "invalid" ? e.body.issues?.[0]?.message ?? "" : "";
  if (message.startsWith("brand_cap")) return "งบเกินเพดานต่อแบรนด์ ระบบไม่สร้างงาน";
  if (message.startsWith("total_cap")) return "งบเกินเพดานรวมทุกแบรนด์ ระบบไม่สร้างงาน";
  return e.thai;
}

type BrandInfo = { id: string; name: string; domain: string };

const CHIP_TONE: Record<Tone, ChipTone> = { live: "success", warn: "warning", bad: "danger", mute: "neutral", blue: "info" };
const StateChip = ({ state }: { state: State }) => <Chip tone={CHIP_TONE[STATE[state].tone]} dot>{STATE[state].label}</Chip>;

/** Status chips above the table: each one groups the derived states the way the design names them. */
type CampaignFilter = "all" | "draft" | "building" | "active" | "paused" | "failed" | "other";
const FILTERS: Array<{ id: CampaignFilter; label: string; states: ReadonlySet<State> | null }> = [
  { id: "all", label: "ทั้งหมด", states: null },
  { id: "draft", label: "ร่าง", states: new Set<State>(["draft"]) },
  { id: "building", label: "กำลังสร้าง", states: new Set<State>(["drafting", "enabling"]) },
  { id: "active", label: "ทำงาน", states: new Set<State>(["enabled"]) },
  { id: "paused", label: "หยุด", states: new Set<State>(["paused"]) },
  { id: "failed", label: "ล้มเหลว", states: new Set<State>(["failed"]) },
  { id: "other", label: "อื่น ๆ", states: new Set<State>(["unknown", "removed"]) },
];
const stamp = (iso: string) => iso.replace("T", " ").slice(0, 16);

export function CampaignsScreen({ me }: { me: Me }) {
  // The server refuses these for a lower role whatever the UI shows; hiding the buttons only spares a 403.
  const canEnable = roleAtLeast(me.role, PANEL_ROLE_TABLE.enableCampaign);
  const canPause = roleAtLeast(me.role, PANEL_ROLE_TABLE.pauseCampaign);
  const [data, setData] = useState<PanelCampaignsResponse | null>(null);
  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(() => api.adsCampaigns().then(setData, (e) => setMsg({ tone: "err", text: thaiError(e) })), []);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.lifecycleBrands(), api.brands()]).then(([lifecycle, runtime]) => {
      if (!active) return;
      const names = new Map((lifecycle.status === "fulfilled" ? lifecycle.value.brands : []).map((b) => [b.brand_id, b]));
      // Core drafts only for brands in brand_runtime, so the runtime list is the source; the factory list adds the name.
      const list = (runtime.status === "fulfilled" ? runtime.value.brands : []).map((b) => {
        const f = names.get(b.brand_id);
        return { id: b.brand_id, name: f?.name ?? b.brand_id, domain: f?.hostnames[0] ?? b.hostnames[0] ?? "" };
      });
      setBrands(list);
    });
    return () => { active = false; };
  }, []);

  const brandOf = (id: string): BrandInfo => brands.find((b) => b.id === id) ?? { id, name: id, domain: "" };

  /** True when the call succeeded. Busy stays set until the list reloaded, so no click lands on stale figures. */
  async function run(key: string, fn: () => Promise<unknown>, done: string): Promise<boolean> {
    if (busy) return false;
    setBusy(key);
    setMsg(null);
    let ok = false;
    try {
      await fn();
      setMsg({ tone: "ok", text: done });
      ok = true;
    } catch (e) {
      setMsg({ tone: "err", text: thaiError(e) });
    } finally {
      await load();
      setBusy(null);
    }
    return ok;
  }

  async function enable(c: PanelCampaign) {
    if (!data || !c.campaign_id) return;
    const brand = brandOf(c.brand_id);
    const { left } = capsFor(data, c.brand_id);
    const requested = c.daily_budget_thb;
    const reason = requested === null || left === null
      ? "ไม่ทราบสกุลเงินของบัญชี จึงตรวจเพดานไม่ได้"
      : satang(requested) > satang(left) ? OVER_CAP : null;
    const ok = await confirm({
      title: `เปิดใช้งาน ${c.name}?`,
      confirmLabel: "เปิดใช้งานและเริ่มใช้เงิน",
      tone: "danger",
      confirmDisabled: reason !== null,
      body: (
        <div className="campaigns-confirm">
          <dl>
            <div><dt>แบรนด์</dt><dd>{brand.name}</dd></div>
            <div><dt>โดเมน</dt><dd>{hostOf(c.final_url)}</dd></div>
            <div><dt>งบต่อวัน</dt><dd>{budgetText(c)}</dd></div>
            <div><dt>พื้นที่เป้าหมาย</dt><dd>{geoText(c.geo)}</dd></div>
            <div><dt>บัญชี Google Ads</dt><dd>{account(c.account)}</dd></div>
            <div><dt>เพดานที่เหลือ</dt><dd>{left === null ? "—" : baht(left)}</dd></div>
          </dl>
          <p className="campaigns-warn">เมื่อเปิดใช้งาน แคมเปญจะเริ่มใช้เงินจริงในบัญชี Google Ads ทันทีที่ VPS ส่งคำสั่ง</p>
          {reason && <p className="campaigns-reason" role="note">{reason}</p>}
        </div>
      ),
    });
    if (ok) await run(c.campaign_id, () => api.enableAdsCampaign(c.campaign_id!), "ส่งคำสั่งเปิดใช้งานแล้ว ระบบตรวจเพดานอีกครั้งก่อน VPS รัน");
  }

  async function pause(c: PanelCampaign) {
    if (!c.campaign_id) return;
    const ok = await confirm({
      title: `หยุด ${c.name}?`,
      body: "แคมเปญจะหยุดใช้เงินเมื่อ VPS ส่งคำสั่งไป AdKit",
      confirmLabel: "หยุดแคมเปญ",
      tone: "danger",
    });
    if (ok) await run(c.campaign_id, () => api.pauseAdsCampaign(c.campaign_id!), "ส่งคำสั่งหยุดแล้ว");
  }

  const statusCheck = (c: PanelCampaign) =>
    c.campaign_id && run(c.campaign_id, () => api.checkAdsCampaignStatus(c.campaign_id!), "ส่งคำสั่งตรวจสถานะแล้ว");

  // The brand scope decides which campaigns show (PLAN A9).
  const { inScopeId } = useBrandScope();
  const shown = useMemo(() => (data?.campaigns ?? []).filter((c) => inScopeId(c.brand_id)), [data, inScopeId]);
  const capBrands = useMemo(() => [...new Set(shown.map((c) => c.brand_id))], [shown]);
  const [filter, setFilter] = useState<CampaignFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const countOf = (id: CampaignFilter) => { const states = FILTERS.find((f) => f.id === id)!.states; return states ? shown.filter((c) => states.has(c.state)).length : shown.length; };
  const visible = useMemo(() => { const states = FILTERS.find((f) => f.id === filter)!.states; return states ? shown.filter((c) => states.has(c.state)) : shown; }, [shown, filter]);
  const selected = shown.find((c) => c.draft_job_id === selectedId) ?? null;

  return (
    <div className="campaigns-page">
      <h1>แคมเปญ</h1>
      <p className="campaigns-sub">แคมเปญ Google Ads ที่สร้างจาก Anjuna ผ่าน AdKit</p>
      <div className="campaigns-banner">
        <strong>แคมเปญที่สร้างจากหน้านี้เป็นร่างเสมอ ยังไม่ใช้เงิน</strong>
        <span>เฉพาะ owner เปิดใช้งานได้ ระบบตรวจเพดานงบทั้งตอนสร้างร่างและตอนเปิดใช้งาน</span>
      </div>
      {msg && <div className={`campaigns-msg ${msg.tone}`} role={msg.tone === "err" ? "alert" : "status"}>{msg.text}</div>}

      <div className="campaigns-chips" role="group" aria-label="กรองสถานะแคมเปญ">
        {FILTERS.filter((f) => f.id !== "other" || countOf("other") > 0).map((f) => (
          <button key={f.id} type="button" className="campaigns-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}<span className="campaigns-chip-count">{countOf(f.id)}</span>
          </button>
        ))}
      </div>

      <div className="campaigns-main">
      <section className="campaigns-card">
        <h2>แคมเปญทั้งหมด</h2>
        {!data ? <p className="campaigns-muted">กำลังโหลด</p> : shown.length === 0 ? <p className="campaigns-muted">ยังไม่มีแคมเปญจากหน้านี้</p> : visible.length === 0 ? <p className="campaigns-muted">ไม่มีแคมเปญในสถานะนี้</p> : (
          <div className="campaigns-scroll"><table>
            <thead><tr><th>แบรนด์</th><th>แคมเปญ</th><th>สถานะ</th><th className="num">งบต่อวัน</th><th>บัญชี</th><th>อัปเดต</th><th><span className="sr-only">การทำงาน</span></th></tr></thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.draft_job_id} className={c.draft_job_id === selectedId ? "sel" : undefined}>
                  <td>{brandOf(c.brand_id).name}</td>
                  <td><button type="button" className="campaigns-pick" aria-pressed={c.draft_job_id === selectedId} onClick={() => setSelectedId(c.draft_job_id === selectedId ? null : c.draft_job_id)}><strong>{c.name}</strong></button></td>
                  <td><StateChip state={c.state} /></td>
                  <td className="num">{budgetText(c)}</td>
                  <td className="num">{account(c.account)}</td>
                  <td className="campaigns-when">{stamp(c.updated_at)}</td>
                  <td className="campaigns-actions">
                    {canEnable && c.campaign_id && ENABLEABLE.has(c.state) && (
                      <button type="button" className="btn pri" disabled={busy !== null} aria-label={`ตรวจและเปิดใช้งาน ${c.name}`} onClick={() => void enable(c)}>ตรวจและเปิดใช้งาน</button>
                    )}
                    {canPause && c.campaign_id && PAUSABLE.has(c.state) && (
                      <button type="button" className="btn" disabled={busy !== null} aria-label={`หยุด ${c.name}`} onClick={() => void pause(c)}>หยุด</button>
                    )}
                    {c.campaign_id && c.state !== "removed" && (
                      <button type="button" className="btn" disabled={busy !== null} aria-label={`ตรวจสถานะ ${c.name}`} onClick={() => void statusCheck(c)}>ตรวจสถานะ</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      <CampaignDetail key={selected?.draft_job_id ?? "none"} campaign={selected} data={data} brandName={selected ? brandOf(selected.brand_id).name : ""} canEditBudget={roleAtLeast(me.role, PANEL_ROLE_TABLE.updateCampaignBudget)} busy={busy !== null}
        onSaveBudget={(c, amount) => run(c.campaign_id!, () => api.updateAdsCampaignBudget(c.campaign_id!, amount), "ส่งคำสั่งเปลี่ยนงบแล้ว ระบบตรวจเพดานอีกครั้งก่อน VPS รัน")} />
      </div>

      <div className="campaigns-split">
        <DraftForm data={data} brands={brands} busy={busy !== null} onSubmit={(body) => run("draft", () => api.draftAdsCampaign(body), "ส่งร่างแล้ว รอ VPS สร้างร่างใน AdKit")} />
        {data && (
          <section className="campaigns-card campaigns-caps">
            <h2>เพดานงบต่อวัน</h2>
            <div className="campaigns-scroll"><table aria-label="เพดานงบต่อวัน">
              <thead><tr><th /><th className="num">เพดาน</th><th className="num">ใช้ไป</th><th className="num">เหลือ</th></tr></thead>
              <tbody>
                <tr>
                  <td>รวมทุกแบรนด์</td>
                  <td className="num">{baht(data.caps.total_thb_day)}</td>
                  <td className="num">{baht(data.enabled_total_thb_day)}</td>
                  <td className="num">{baht(Math.max(0, satang(data.caps.total_thb_day) - satang(data.enabled_total_thb_day)) / 100)}</td>
                </tr>
                {capBrands.map((id) => {
                  const { brandUsed, left } = capsFor(data, id);
                  return (
                    <tr key={id}>
                      <td>{brandOf(id).name}</td>
                      <td className="num">{baht(data.caps.brand_thb_day)}</td>
                      <td className="num">{brandUsed === null ? "—" : baht(brandUsed)}</td>
                      <td className="num">{left === null ? "—" : baht(left)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
            <p className="campaigns-muted">นับงบของแคมเปญที่ทำงาน กำลังเปิด หรือไม่ทราบผล เพดานจำกัดงบที่เปิดได้ ไม่ใช่เป้าการใช้เงิน{roleAtLeast(me.role, PANEL_ROLE_TABLE.viewSettings) ? " แก้เพดานได้ในหน้าตั้งค่า" : ""}</p>
          </section>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

/**
 * The selected campaign: budget (owner edits it through the budget job), keywords and the latest job. Core returns no keyword list
 * and no job history on this read, so the panel shows only what the read holds: the derived state, its time and the draft job id.
 */
function CampaignDetail({ campaign, data, brandName, canEditBudget, busy, onSaveBudget }: {
  campaign: PanelCampaign | null;
  data: PanelCampaignsResponse | null;
  brandName: string;
  canEditBudget: boolean;
  busy: boolean;
  onSaveBudget: (campaign: PanelCampaign, amount: number) => Promise<boolean>;
}) {
  const [budget, setBudget] = useState(campaign ? String(campaign.daily_budget) : "");
  if (!campaign) {
    return <aside className="campaigns-card campaigns-detail" aria-label="รายละเอียดแคมเปญ"><h2>รายละเอียด</h2><p className="campaigns-muted">เลือกแคมเปญในตารางเพื่อดูงบ คีย์เวิร์ดและบันทึกงาน</p></aside>;
  }
  const amount = Number(budget);
  // The budget job takes a positive number with at most two decimals.
  const amountOk = budget.trim() !== "" && Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;
  const info = data?.brands.find((b) => b.brand_id === campaign.brand_id);
  const rate = campaign.currency === "THB" ? 1 : (info?.thb_per_unit ?? null);
  const left = data ? capsFor(data, campaign.brand_id).left : null;
  // The campaign's own budget is already inside the committed figure while it spends, so an edit may use that share again.
  const own = campaign.state === "enabled" && campaign.daily_budget_thb !== null ? campaign.daily_budget_thb : 0;
  const over = amountOk && rate !== null && left !== null && satang(amount * rate) > satang(left + own);
  const changed = amountOk && amount !== campaign.daily_budget;
  const editable = canEditBudget && campaign.campaign_id !== null && campaign.state !== "removed";
  return (
    <aside className="campaigns-card campaigns-detail" aria-label="รายละเอียดแคมเปญ">
      <div className="campaigns-detail-head">
        <div><p className="campaigns-muted">{brandName}</p><h2>{campaign.name}</h2></div>
        <StateChip state={campaign.state} />
      </div>
      <div className="campaigns-detail-block">
        <label htmlFor="cmp-detail-budget">งบต่อวัน{campaign.currency ? ` (${campaign.currency})` : ""}</label>
        {editable ? (
          <div className="campaigns-budget-row">
            <input id="cmp-detail-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button type="button" className="btn pri" disabled={busy || !changed || over} onClick={() => void onSaveBudget(campaign, amount)}>บันทึกงบ</button>
          </div>
        ) : (
          <>
            <output id="cmp-detail-budget" className="campaigns-budget-read">{budgetText(campaign)}</output>
            <p className="campaigns-muted">{!canEditBudget ? "เฉพาะ owner แก้งบได้" : campaign.state === "removed" ? "แคมเปญนี้ถูกลบใน Google Ads แล้ว" : "แคมเปญยังไม่มีรหัสใน Google Ads แก้งบไม่ได้"}</p>
          </>
        )}
        {over && <p className="campaigns-reason" role="note">{OVER_CAP}</p>}
        {editable && <p className="campaigns-muted">งบใหม่ส่งเป็นงานไป AdKit ระบบตรวจเพดานอีกครั้งก่อนเปลี่ยน</p>}
      </div>
      <div className="campaigns-detail-block">
        <h3>คีย์เวิร์ด</h3>
        <p className="campaigns-muted">ระบบยังไม่ส่งรายการคีย์เวิร์ดกลับมาในหน้านี้ ดูใน Google Ads</p>
      </div>
      <div className="campaigns-detail-block">
        <h3>บันทึกงาน</h3>
        <ol className="campaigns-log">
          <li><span className="campaigns-log-dot" aria-hidden="true" /><div><b>{STATE[campaign.state].label}</b><small>{stamp(campaign.updated_at)} · <code>{campaign.draft_job_id.slice(0, 8)}</code></small></div></li>
        </ol>
        <p className="campaigns-muted">Final URL: <code>{hostOf(campaign.final_url)}</code> · {geoText(campaign.geo)}</p>
      </div>
    </aside>
  );
}

type DraftBody = Parameters<typeof api.draftAdsCampaign>[0];

function DraftForm({ data, brands, busy, onSubmit }: { data: PanelCampaignsResponse | null; brands: BrandInfo[]; busy: boolean; onSubmit: (body: DraftBody) => Promise<boolean> }) {
  const [brandId, setBrandId] = useState("");
  const [budget, setBudget] = useState("");
  const [bid, setBid] = useState<DraftBody["bid_strategy"]>("maximize_conversions");
  const [geoType, setGeoType] = useState<"country" | "city">("country");
  const [geoValue, setGeoValue] = useState("");
  const [keywords, setKeywords] = useState("");
  const [finalUrl, setFinalUrl] = useState("");

  const brand = brands.find((b) => b.id === brandId);
  // `<brand_id>-search-<n>`: one more than the largest n this brand already used.
  const name = useMemo(() => {
    if (!brandId) return "";
    const used = (data?.campaigns ?? []).filter((c) => c.brand_id === brandId)
      .map((c) => Number(c.name.slice(`${brandId}-search-`.length)) || 0);
    return `${brandId}-search-${Math.max(0, ...used) + 1}`;
  }, [brandId, data]);

  const amount = Number(budget);
  const amountOk = budget.trim() !== "" && Number.isFinite(amount) && amount > 0;
  // The budget is in the account currency. Without a baht rate the pre-check is skipped and core decides (it always rechecks).
  const info = data?.brands.find((b) => b.brand_id === brandId);
  const rate = info?.thb_per_unit ?? null;
  const left = data && brandId ? capsFor(data, brandId).left : null;
  const over = amountOk && rate !== null && left !== null && satang(amount * rate) > satang(left);
  const lines = keywords.split("\n").map((k) => k.trim()).filter(Boolean);
  const ready = !!brandId && amountOk && !over && geoValue.trim() !== "" && lines.length > 0 && finalUrl.trim() !== "" && !busy;

  function pickBrand(id: string) {
    setBrandId(id);
    const b = brands.find((x) => x.id === id);
    setFinalUrl(b?.domain ? `https://${b.domain}/` : "");
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const geo: Geo = geoType === "country" ? { country: geoValue.trim().toUpperCase() } : { city_code: geoValue.trim() };
    const ok = await onSubmit({ brand_id: brandId, name, daily_budget: amount, bid_strategy: bid, geo, keywords: lines, final_url: finalUrl.trim() });
    // A second click would send the same draft again under the next auto-name, so a sent draft empties the form.
    if (ok) {
      setBrandId("");
      setBudget("");
      setGeoValue("");
      setKeywords("");
      setFinalUrl("");
    }
  }

  return (
    <form className="campaigns-card campaigns-form" aria-label="ร่างแคมเปญใหม่" onSubmit={(e) => void submit(e)}>
      <h2>ร่างแคมเปญใหม่</h2>
      <p className="campaigns-muted">Google Search เท่านั้น ส่งเป็นร่างไป AdKit ยังไม่ใช้เงิน</p>
      <div className="campaigns-grid">
        <div className="campaigns-field">
          <label htmlFor="cmp-brand">แบรนด์</label>
          <select id="cmp-brand" value={brandId} onChange={(e) => pickBrand(e.target.value)}>
            <option value="">เลือกแบรนด์</option>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}{b.domain ? ` · ${b.domain}` : ""}</option>)}
          </select>
        </div>
        <div className="campaigns-field">
          <label htmlFor="cmp-name">ชื่อแคมเปญ</label>
          <input id="cmp-name" value={name} readOnly />
          <small>ตั้งจากรหัสแบรนด์ให้อัตโนมัติ</small>
        </div>
        <div className="campaigns-field">
          <label htmlFor="cmp-budget">งบต่อวัน</label>
          <input id="cmp-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
          <small>
            {info?.currency ? `สกุลเงินของบัญชี Google Ads: ${info.currency}` : "สกุลเงินของบัญชี Google Ads"}
            {rate !== null && info?.currency !== "THB" ? ` · 1 ${info?.currency} = ${baht(rate)}` : ""}
            {left !== null ? ` · เพดานที่เหลือ ${baht(left)}` : ""}
            {brandId && (rate === null || left === null) ? " · ยังคำนวณเพดานเป็นบาทไม่ได้ ระบบจะตรวจตอนส่ง" : ""}
          </small>
          {over && <small className="campaigns-reason" role="note">{OVER_CAP}</small>}
        </div>
        <div className="campaigns-field">
          <label htmlFor="cmp-bid">กลยุทธ์ประมูล</label>
          <select id="cmp-bid" value={bid} onChange={(e) => setBid(e.target.value as DraftBody["bid_strategy"])}>
            <option value="maximize_conversions">เพิ่มคอนเวอร์ชันให้มากที่สุด</option>
            <option value="maximize_clicks">เพิ่มคลิกให้มากที่สุด</option>
          </select>
        </div>
        <div className="campaigns-field">
          <label htmlFor="cmp-geo-type">ประเภทพื้นที่</label>
          <select id="cmp-geo-type" value={geoType} onChange={(e) => setGeoType(e.target.value as "country" | "city")}>
            <option value="country">ประเทศ</option>
            <option value="city">เมือง</option>
          </select>
        </div>
        <div className="campaigns-field">
          <label htmlFor="cmp-geo">รหัสประเทศหรือรหัสเมือง</label>
          <input id="cmp-geo" value={geoValue} onChange={(e) => setGeoValue(e.target.value)} placeholder={geoType === "country" ? "US" : "1023191"} />
        </div>
        <div className="campaigns-field campaigns-wide">
          <label htmlFor="cmp-keywords">คีย์เวิร์ด หนึ่งบรรทัดต่อคำ</label>
          <textarea id="cmp-keywords" rows={4} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
        </div>
        <div className="campaigns-field campaigns-wide">
          <label htmlFor="cmp-url">Final URL</label>
          <input id="cmp-url" value={finalUrl} onChange={(e) => setFinalUrl(e.target.value)} />
          <small>ต้องอยู่บนโดเมนของแบรนด์</small>
        </div>
      </div>
      <div className="campaigns-foot">
        <button type="submit" className="btn pri" disabled={!ready}>ส่งร่างไป AdKit</button>
      </div>
    </form>
  );
}
