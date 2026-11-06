import type { FunnelReportResponse, TrafficBreakdownResponse, TrafficDimension, TrafficPeriod } from "@anjuna/contracts";
import { useEffect, useState } from "react";
import { z } from "zod";
import { ApiError, api } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";
import { RiskPanel } from "./RiskPanel";

const periods: Array<[TrafficPeriod, string]> = [["today", "วันนี้"], ["7d", "7 วัน"], ["30d", "30 วัน"]];
const tabs = { source: "แหล่งที่มา", domain: "โดเมน", device: "อุปกรณ์", browser: "Browser" } as const;
type Tab = keyof typeof tabs;
const number = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("th-TH");
const rate = (n: number | null) => n === null ? "—" : `${(n * 100).toFixed(1)}%`;
const message = (e: unknown) => e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ";
const Spend = z.object({ brands: z.array(z.object({ brand_id: z.string(), clicks: z.number().int().nonnegative() })) });

// C2 owns api.spend. Read its agreed HTTP contract without requiring that branch to be merged.
async function paidClicks(period: TrafficPeriod): Promise<Map<string, number>> {
  const response = await fetch(`/api/spend?period=${period}`, { credentials: "same-origin" });
  if (response.status === 404 || response.status === 403) return new Map();
  if (!response.ok) throw new Error("spend unavailable");
  // A brand has one spend row per billing currency; its paid clicks are the sum of them.
  const clicks = new Map<string, number>();
  for (const b of Spend.parse(await response.json()).brands) clicks.set(b.brand_id, (clicks.get(b.brand_id) ?? 0) + b.clicks);
  return clicks;
}

export function biggestLeak(stages: Array<[string, number | null]>): { label: string; loss: number } | null {
  let worst: { label: string; loss: number } | null = null;
  for (let i = 1; i < stages.length; i++) {
    const previous = stages[i - 1]![1];
    const [label, current] = stages[i]!;
    if (previous === null || current === null || previous <= 0) continue;
    const loss = Math.max(0, 1 - current / previous);
    if (loss > 0 && (!worst || loss > worst.loss)) worst = { label, loss };
  }
  return worst;
}

function trafficLabel(by: TrafficDimension, key: string): string {
  if (key === "unknown") return "ไม่ทราบ";
  if (by === "device") return ({ mobile: "มือถือ", desktop: "เดสก์ท็อป", tablet: "แท็บเล็ต" } as Record<string, string>)[key] ?? key;
  if (by === "browser") return ({ chrome: "Chrome", safari: "Safari", edge: "Edge", firefox: "Firefox", other: "อื่น ๆ" } as Record<string, string>)[key] ?? key;
  return key;
}

export function FunnelScreen() {
  const [period, setPeriod] = useState<TrafficPeriod>("today");
  const [tab, setTab] = useState<Tab>("source");
  const [traffic, setTraffic] = useState<TrafficBreakdownResponse | null>(null);
  const [breakdown, setBreakdown] = useState<TrafficBreakdownResponse | null>(null);
  const [hours, setHours] = useState<TrafficBreakdownResponse | null>(null);
  const [report, setReport] = useState<FunnelReportResponse | null>(null);
  const [paid, setPaid] = useState(new Map<string, number>());
  const [owner, setOwner] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [breakdownError, setBreakdownError] = useState<string | null>(null);
  const [hourError, setHourError] = useState<string | null>(null);
  const [spendError, setSpendError] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const labelOf = useBrandLabels();

  useEffect(() => {
    let active = true;
    setTraffic(null); setReport(null); setError(null); setReportError(null);
    void api.trafficBreakdown(period, "source").then(async (data) => {
      if (!active) return;
      setTraffic(data);
      try {
        const funnel = await api.funnel({ from: data.from, to: data.to });
        if (active) setReport(funnel);
      } catch (e) { if (active) setReportError(message(e)); }
    }).catch((e: unknown) => { if (active) setError(message(e)); });
    return () => { active = false; };
  }, [period]);

  useEffect(() => {
    let active = true;
    setHours(null); setHourError(null);
    void api.trafficBreakdown(period, "hour").then((data) => { if (active) setHours(data); })
      .catch((e: unknown) => { if (active) setHourError(message(e)); });
    return () => { active = false; };
  }, [period]);

  useEffect(() => {
    let active = true;
    setBreakdown(null); setBreakdownError(null);
    if (tab !== "source") {
      void api.trafficBreakdown(period, tab).then((data) => { if (active) setBreakdown(data); })
        .catch((e: unknown) => { if (active) setBreakdownError(message(e)); });
    }
    return () => { active = false; };
  }, [period, tab]);

  useEffect(() => {
    let active = true;
    setPaid(new Map()); setSpendError(false);
    void api.me().then(async (me) => {
      if (!active) return;
      setOwner(me.role === "owner");
      if (me.role !== "owner") return;
      try { const data = await paidClicks(period); if (active) setPaid(data); }
      catch { if (active) setSpendError(true); }
    }).catch(() => { if (active) setOwner(false); });
    return () => { active = false; };
  }, [period]);

  const selected = tab === "source" ? traffic : breakdown;
  const selectedError = tab === "source" ? error : breakdownError;
  const maxVisits = Math.max(1, ...(selected?.rows.map((r) => r.visits) ?? []));
  const maxHour = Math.max(1, ...(hours?.rows.map((r) => r.visits) ?? []));
  const brands = new Map((traffic?.brands ?? []).map((b) => [b.brand_id, b]));
  // Keep brands with sales/spend but no entry telemetry visible, without inventing visits.
  for (const id of [...(report?.rows.map((r) => r.brand) ?? []), ...paid.keys()]) {
    if (!brands.has(id)) brands.set(id, { brand_id: id, hostname: "", visits: 0, go_count: null, form_views: 0, leads: 0 });
  }

  return <>
    <div className="head" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
      <div><h1>ฟันเนล</h1><p className="sub">ดูว่าแต่ละแบรนด์เสียคนไปตรงไหนมากที่สุด</p></div>
      <div className="seg" aria-label="ช่วงเวลา">{periods.map(([value, label]) =>
        <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}
      </div>
    </div>
    <section className="panel" aria-label="ฟันเนลรายแบรนด์">
      {error ? <p role="alert">{error}</p> : !traffic ? <p role="status">กำลังโหลด…</p> :
        <div className="tw"><table><thead><tr>
          <th>แบรนด์</th><th>คลิกที่จ่าย</th><th>ถึงเว็บ</th><th>ถึง /go</th><th>เปิดฟอร์ม</th><th>ลีด</th><th>ขายได้</th><th>จุดรั่วมากสุด</th>
        </tr></thead><tbody>{[...brands.values()].map((b) => {
          const sold = report ? report.rows.filter((r) => r.brand === b.brand_id).reduce((sum, r) => sum + r.sold, 0) : null;
          const clicks = paid.get(b.brand_id) ?? null;
          const leak = biggestLeak([["คลิกที่จ่าย", clicks], ["ถึงเว็บ", b.visits], ["ถึง /go", b.go_count], ["ฟอร์ม", b.form_views], ["ลีด", b.leads]]);
          const known = labelOf(b.brand_id);
          return <tr key={b.brand_id}>
            <td><BrandLabel brandId={b.brand_id} domain={known !== b.brand_id ? known : b.hostname || known} /></td>
            <td className="blue">{number(clicks)}</td><td>{number(b.visits)}</td><td>{number(b.go_count)}</td>
            <td>{number(b.form_views)}</td><td>{number(b.leads)}</td><td>{number(sold)}</td>
            <td>{leak ? <span className={`pill ${leak.loss > .8 ? "p-warn" : "p-mute"}`}>{leak.label} หลุด {Math.round(leak.loss * 100)}%</span> : <span className="pill p-mute">—</span>}</td>
          </tr>;
        })}{brands.size === 0 && <tr><td colSpan={8} className="hint">ไม่มีข้อมูลในช่วงนี้</td></tr>}</tbody></table></div>}
      <p className="hint">นับเซสชันไม่ซ้ำในช่วงเวลา UTC · ลีดนับจากเซสชันที่เข้าเว็บในช่วงนี้ · /go ยังไม่มีข้อมูลการวัด · ขายได้มาจากผลขายในช่วงเวลาเดียวกัน</p>
      {spendError && <p role="alert" className="hint">โหลดคลิกที่จ่ายไม่สำเร็จ</p>}
    </section>

    <section className="panel" style={{ marginTop: 16 }} aria-label="แหล่งที่มาของผู้เข้าชม">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2>คนที่เข้าเว็บมาจากไหน</h2>
        <div className="seg" aria-label="แยกผู้เข้าชม">{(Object.entries(tabs) as Array<[Tab, string]>).map(([key, label]) =>
          <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
        </div>
      </div>
      {selectedError ? <p role="alert">{selectedError}</p> : !selected || selected.period !== period || selected.by !== tab ? <p role="status">กำลังโหลด…</p> :
        <div className="tw" style={{ marginTop: 8 }}><table><thead><tr><th>{tabs[tab]}</th><th style={{ width: "40%" }} aria-label="สัดส่วนผู้เข้าชม" /><th>เข้าเว็บ</th><th>ลีด</th><th>อัตราลีด</th></tr></thead>
          <tbody>{selected.rows.map((r) => <tr key={r.key}><td>{trafficLabel(tab, r.key)}</td>
            <td><div className="prog"><i style={{ width: `${r.visits / maxVisits * 100}%`, background: "var(--spend)" }} /></div></td>
            <td>{number(r.visits)}</td><td>{number(r.leads)}</td><td className={r.visits > 0 && r.leads / r.visits < .01 ? "amb" : ""}>{rate(r.visits > 0 ? r.leads / r.visits : null)}</td>
          </tr>)}{selected.rows.length === 0 && <tr><td colSpan={5} className="hint">ไม่มีข้อมูลในช่วงนี้</td></tr>}</tbody>
        </table></div>}
      <h3 style={{ marginTop: 14 }}>ตามชั่วโมง (เวลาสหรัฐฯ ฝั่งตะวันออก)</h3>
      {hourError ? <p role="alert">{hourError}</p> : !hours ? <p role="status">กำลังโหลด…</p> : <>
        <div role="img" aria-label="จำนวนคนเข้าเว็บแต่ละชั่วโมง" style={{ display: "grid", gridTemplateColumns: "repeat(24,minmax(0,1fr))", gap: 2, alignItems: "end", height: 90, marginTop: 8 }}>
          {hours.rows.map((h) => <div key={h.key} title={`${h.key}:00 เข้าเว็บ ${h.visits} ลีด ${h.leads}`} style={{ height: `${h.visits / maxHour * 80}px`, background: "var(--spend)", opacity: .55, borderRadius: "2px 2px 0 0" }} />)}
        </div>
        <div className="hint" style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>{["00:00", "06:00", "12:00", "18:00", "23:00"].map((h) => <span key={h}>{h}</span>)}</div>
        {hours.rows.every((h) => h.visits === 0) && <p className="hint">ไม่มีข้อมูลรายชั่วโมงในช่วงนี้</p>}
      </>}
    </section>

    <RiskPanel period={period} canExport={owner} />

    <section className="panel" style={{ marginTop: 16 }}>
      <h2>แยกตามคีย์เวิร์ดและ A/B</h2>
      {reportError ? <p role="alert">{reportError}</p> : error ? <p className="hint">ยังโหลดรายงานไม่ได้</p> : !report ? <p role="status">กำลังโหลด…</p> :
        <div className="tw"><table><thead><tr><th>แบรนด์</th><th>คีย์เวิร์ด</th><th>ตัวแปร</th><th>คลิก</th><th>/go</th><th>เปิดฟอร์ม</th><th>ส่ง</th><th>ขายได้</th>{owner && <th>รายได้</th>}<th>อัตราส่ง</th><th>อัตราขาย</th></tr></thead>
          <tbody>{report.rows.map((r) => <tr key={JSON.stringify([r.brand, r.keyword, r.variant])}>
            <td><BrandLabel brandId={r.brand} domain={labelOf(r.brand)} /></td><td>{r.keyword ?? "—"}</td><td>{r.variant ?? "—"}</td><td>{r.clicks}</td><td>{r.go_count}</td><td>{r.form_views}</td><td>{r.submits}</td><td>{r.sold}</td>
            {owner && <td>{r.revenue === null ? "—" : r.revenue.toFixed(2)}</td>}<td>{rate(r.submit_rate)}</td><td>{rate(r.sold_rate)}</td>
          </tr>)}{report.rows.length === 0 && <tr><td colSpan={owner ? 11 : 10} className="hint">ไม่มีข้อมูลในช่วงนี้</td></tr>}</tbody>
        </table></div>}
    </section>
  </>;
}
