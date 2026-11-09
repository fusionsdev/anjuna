// T13 A3: tab "จัดสรรค่าโฆษณา" (owner only). Google Ads accounts that several brands share, their campaigns with 7 day
// cost, who owns each one, the allocation mode and the cost no brand got. The owner gives an unmapped campaign to a brand.
import type { AdAllocationAccount, AdAllocationCampaign, AdAllocationResponse, CampaignMapSource, SpendCostByCurrency } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { BrandLabel, useBrandLabels } from "../brand-labels";
import { DataTable, type Column } from "../components/DataTable";
import { Spinner } from "../components/Spinner";
import { byCurrencyText } from "./BrandStatsRow";

const MODE_TEXT: Record<AdAllocationResponse["mode"], string> = {
  estimated: "ประมาณจากสัดส่วนคลิก: แคมเปญที่ยังไม่จัดสรรแบ่งให้ทุกแบรนด์ในบัญชีตามจำนวนคลิก",
  exact_only: "นับเฉพาะแคมเปญที่จัดสรรแล้ว: แคมเปญที่ยังไม่จัดสรรไม่นับเป็นของแบรนด์ใด",
};

const SOURCE_TEXT: Record<CampaignMapSource, string> = {
  create: "สร้างจากแผงควบคุม",
  click: "จากคลิก",
  manual: "กำหนดเอง",
};

/** "538-116-3935", the way Google Ads shows an account. */
const accountText = (account: string) => `${account.slice(0, 3)}-${account.slice(3, 6)}-${account.slice(6)}`;

/** Amounts per currency with no zero currency, "฿0" when the account has no cost at all. */
function moneyText(value: SpendCostByCurrency): string {
  const shown = Object.fromEntries((["THB", "USD"] as const).filter((c) => value[c] > 0).map((c) => [c, value[c]]));
  return Object.keys(shown).length ? byCurrencyText(shown) : "฿0";
}

/** Share of the account's cost that no brand owns, per currency, e.g. "27%". "—" with no cost. */
function shareText(account: AdAllocationAccount): string {
  const parts = (["THB", "USD"] as const)
    .filter((c) => account.cost_by_currency[c] > 0)
    .map((c) => `${Math.round((account.unmapped_cost_by_currency[c] / account.cost_by_currency[c]) * 100)}%`);
  return parts.length ? parts.join(" · ") : "—";
}

export function AdAllocationScreen() {
  const [data, setData] = useState<AdAllocationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const labelOf = useBrandLabels();

  const load = useCallback(() => {
    setError(null);
    api.adAllocation().then(setData, (e) => setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ"));
  }, []);
  useEffect(load, [load]);

  const brandsOf = (account: string) => data?.accounts.find((a) => a.account === account)?.brands ?? [];
  const keyOf = (c: AdAllocationCampaign) => `${c.account}:${c.campaign_id}:${c.currency}`;

  const assign = async (campaign: AdAllocationCampaign, brandId: string) => {
    setSaving(keyOf(campaign));
    setSaveError(null);
    try {
      await api.assignAdCampaign({ account: campaign.account, campaign_id: campaign.campaign_id, brand_id: brandId });
      setData(await api.adAllocation());
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.thai : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(null);
    }
  };

  const accountColumns: Column<AdAllocationAccount>[] = [
    { key: "account", header: "บัญชี Google Ads", mono: true, cell: (a) => accountText(a.account) },
    { key: "brands", header: "แบรนด์", cell: (a) => <>{a.brands.map((b) => <div key={b}><BrandLabel brandId={b} domain={labelOf(b)} /></div>)}</> },
    { key: "cost", header: "ค่าโฆษณา 7 วัน", align: "right", cell: (a) => moneyText(a.cost_by_currency) },
    { key: "unmapped", header: "ยังไม่จัดสรร", align: "right", cell: (a) => moneyText(a.unmapped_cost_by_currency) },
    { key: "share", header: "สัดส่วนที่ยังไม่จัดสรร", align: "right", cell: shareText },
  ];

  const campaignColumns: Column<AdAllocationCampaign>[] = [
    { key: "campaign", header: "แคมเปญ", mono: true, cell: (c) => c.campaign_id },
    { key: "account", header: "บัญชี", mono: true, cell: (c) => accountText(c.account) },
    { key: "cost", header: "ค่าโฆษณา 7 วัน", align: "right", cell: (c) => byCurrencyText({ [c.currency]: c.cost }) },
    { key: "clicks", header: "คลิก", align: "right", cell: (c) => c.clicks.toLocaleString("en-US") },
    {
      key: "source", header: "ที่มา",
      cell: (c) => c.source ? <span className="pill p-live">{SOURCE_TEXT[c.source]}</span> : <span className="pill p-warn">ยังไม่จัดสรร</span>,
    },
    {
      key: "brand", header: "แบรนด์",
      cell: (c) => (
        <select
          aria-label={`แบรนด์ของแคมเปญ ${c.campaign_id}`}
          value={c.brand_id ?? ""}
          disabled={saving !== null}
          onChange={(e) => { if (e.target.value) void assign(c, e.target.value); }}
        >
          {c.brand_id === null && <option value="" disabled>เลือกแบรนด์</option>}
          {brandsOf(c.account).map((b) => <option key={b} value={b}>{labelOf(b)}</option>)}
        </select>
      ),
    },
  ];

  return <div className="stack ad-allocation-page">
    <div className="head">
      <div>
        <h1>จัดสรรค่าโฆษณา</h1>
        <p className="sub">บัญชี Google Ads ที่หลายแบรนด์ใช้ร่วมกัน แคมเปญของแต่ละบัญชี และแบรนด์ที่เป็นเจ้าของ{data ? ` · ${data.from} ถึง ${data.to}` : ""}</p>
      </div>
    </div>
    {error
      ? <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">
        <p>{error}</p>
        <button type="button" className="btn" onClick={load}>ลองอีกครั้ง</button>
      </div>
      : !data ? <Spinner />
      : <>
        <section className="panel" aria-label="สรุปการจัดสรร">
          <div className="status-grid">
            <div><span className="muted">โหมด</span><strong>{MODE_TEXT[data.mode]}</strong></div>
            <div><span className="muted">ค่าโฆษณาที่ไม่ได้ให้แบรนด์ใด 7 วัน</span><strong>{moneyText(data.unallocated_by_currency)}</strong></div>
          </div>
          <p className="hint">แคมเปญที่จัดสรรแล้วนับเป็นของแบรนด์นั้นทั้งหมด ตัวเลขที่ประมาณจะมี "~" ในหน้าแบรนด์และหน้าแรก การเปลี่ยนแบรนด์มีผลกับข้อมูลที่ซิงก์รอบถัดไป</p>
        </section>
        <section className="panel" aria-label="บัญชีที่ใช้ร่วมกัน">
          <h2>บัญชีที่ใช้ร่วมกัน</h2>
          <DataTable label="บัญชีที่ใช้ร่วมกัน" columns={accountColumns} rows={data.accounts} rowKey={(a) => a.account}
            empty={<p className="hint">ไม่มีบัญชีที่หลายแบรนด์ใช้ร่วมกัน</p>} />
        </section>
        <section className="panel" aria-label="แคมเปญ">
          <h2>แคมเปญ</h2>
          {saveError && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">{saveError}</div>}
          <DataTable label="แคมเปญ" columns={campaignColumns} rows={data.campaigns} rowKey={keyOf}
            empty={<p className="hint">ยังไม่มีค่าโฆษณาระดับแคมเปญใน 7 วันนี้</p>} />
        </section>
      </>}
  </div>;
}
