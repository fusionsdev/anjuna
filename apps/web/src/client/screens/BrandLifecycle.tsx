import type { ChecklistItemName, LifecycleBrandSummary, InstallWithReceipts } from "@anjuna/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { reduceLifecycleState, shouldPollLifecycle, type LifecycleState } from "../lifecycle-state";

const checklistItems: Array<{ item: ChecklistItemName; label: string }> = [
  { item: "drain_route", label: "Drain route" },
  { item: "leadsgate_postbacks", label: "LeadsGate postbacks" },
  { item: "test_sold", label: "Test sold" },
  { item: "final_url", label: "Final URL suffix keyword={keyword}" },
];

const statusLabel: Record<string, string> = {
  draft: "ฉบับร่าง (draft)", queued: "รอคิว (queued)", running: "กำลังทำงาน (running)", ready: "พร้อมใช้งาน (ready)",
  failed: "ล้มเหลว (failed)", rolled_back: "ย้อนกลับแล้ว (rolled-back)", detached: "ถอดออกแล้ว (detached)", unmanaged: "ไม่ได้จัดการ (unmanaged)", sync_error: "ซิงก์ผิดพลาด (sync_error)",
};

export function BrandLifecycle({ me }: { me: Me }) {
  const [brands, setBrands] = useState<LifecycleBrandSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<LifecycleState>();
  const [install, setInstall] = useState<InstallWithReceipts | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ domain: "", keyword_default: "", template_version_id: "" });
  const [upgrade, setUpgrade] = useState({ from_template_version_id: "", to_template_version_id: "", form_artifact_id: "", canary_brand_id: "" });

  const load = useCallback(async () => {
    try { const result = await api.lifecycleBrands(); setBrands(result.brands); setError(null); if (!selectedId && result.brands[0]) setSelectedId(result.brands[0].brand_id); }
    catch (e) { setError(e instanceof ApiError ? e.thai : "โหลด lifecycle ไม่สำเร็จ"); }
  }, [selectedId]);
  useEffect(() => { void load(); }, [load]);

  const selected = useMemo(() => brands.find((b) => b.brand_id === selectedId), [brands, selectedId]);
  useEffect(() => {
    if (!selected) return;
    setState((previous) => reduceLifecycleState(previous, { type: "brand", brand: selected }));
  }, [selected]);
  useEffect(() => {
    if (!install || !shouldPollLifecycle(state)) return;
    const timer = window.setInterval(() => { void api.installDetail(install.install_id).then((next) => { setInstall(next); setState((previous) => reduceLifecycleState(previous, { type: "install", install: next })); }, () => undefined); }, 3000);
    return () => window.clearInterval(timer);
  }, [install, state]);

  async function act(action: () => Promise<unknown>) { try { setError(null); await action(); await load(); } catch (e) { setError(e instanceof ApiError ? e.thai : "ดำเนินการไม่สำเร็จ"); } }
  async function createDraft() { await act(async () => { const result = await api.createDraft(draft); setSelectedId(result.brand.brand_id); setDraft({ domain: "", keyword_default: "", template_version_id: "" }); }); }
  async function startInstall() { if (!selected) return; await act(async () => { const result = await api.install(selected.brand_id, selected.current_revision_id ?? undefined); const detail = await api.installDetail(result.install_id); setInstall(detail); setState((previous) => reduceLifecycleState(previous, { type: "install", install: detail })); }); }
  async function rollback() { if (!selected) return; await act(async () => { const result = await api.rollbackLifecycle(selected.brand_id); const detail = await api.installDetail(result.install_id); setInstall(detail); }); }

  return <div className="lifecycle-grid">
    <section className="card lifecycle-list">
      <div className="row split"><h1>Lifecycle แบรนด์</h1><button className="primary" onClick={() => void createDraft()}>สร้างแบรนด์ (Create draft)</button></div>
      {error && <div className="error" role="alert">{error}</div>}
      <form className="section" onSubmit={(e) => { e.preventDefault(); void createDraft(); }}>
        <h3>เพิ่มแบรนด์ (Domain + Keyword + Template)</h3>
        <label>Domain<input required value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} placeholder="example.com" /></label>
        <label>Keyword<input required value={draft.keyword_default} onChange={(e) => setDraft({ ...draft, keyword_default: e.target.value })} placeholder="Fast cash" /></label>
        <label>Sealed template version<input required value={draft.template_version_id} onChange={(e) => setDraft({ ...draft, template_version_id: e.target.value })} placeholder="template-version-id" /></label>
        <button className="primary" type="submit">สร้าง draft</button>
      </form>
      <div className="lifecycle-brand-list"><h3>สถานะ (Lifecycle status)</h3>{brands.map((brand) => <button key={brand.brand_id} className={brand.brand_id === selectedId ? "lifecycle-brand selected" : "lifecycle-brand"} onClick={() => setSelectedId(brand.brand_id)}><b>{brand.hostnames[0] ?? brand.brand_id}</b><span>{statusLabel[brand.status] ?? brand.status}</span></button>)}</div>
      <p className="muted small">Actions: Install · Rollback · Retry · Test sold</p>
    </section>
    {selected && <LifecycleDetail me={me} brand={selected} state={state} install={install} onInstall={() => void startInstall()} onRollback={() => void rollback()} onRetry={() => install && void act(async () => { const next = await api.retryInstall(install.install_id); const detail = await api.installDetail(next.install_id); setInstall(detail); setState((previous) => reduceLifecycleState(previous, { type: "retry", install_id: install.install_id, compensation_install_id: next.install_id })); })} onChecklist={(item) => void act(() => api.attestChecklist(selected.brand_id, item))} />}
    {me.role === "owner" && <section className="card upgrade-card"><h2>Upgrade-all (Owner only)</h2><p className="muted">Canary-first upgrade; target artifact ต้องมี payload <code>2026-01</code> และ bundle identity แยกเป็น <code>form@…</code></p><div className="form-inline">{Object.entries(upgrade).map(([key, value]) => <input key={key} aria-label={key} placeholder={key} value={value} onChange={(e) => setUpgrade({ ...upgrade, [key]: e.target.value })} />)}<button className="danger" onClick={() => void act(() => api.upgradeAll(upgrade))}>เริ่ม Upgrade-all</button></div></section>}
  </div>;
}

function LifecycleDetail({ me, brand, state, install, onInstall, onRollback, onRetry, onChecklist }: { me: Me; brand: LifecycleBrandSummary; state?: LifecycleState; install?: InstallWithReceipts; onInstall: () => void; onRollback: () => void; onRetry: () => void; onChecklist: (item: ChecklistItemName) => void }) {
  return <section className="card lifecycle-detail"><div className="row split"><div><h2>{brand.hostnames[0] ?? brand.brand_id}</h2><p className="muted">{brand.brand_id} · form <code>{brand.bundle_form_version ?? "—"}</code> · payload <code>{brand.payload_version ?? "—"}</code></p></div><span className={`pill ${brand.status}`}>{statusLabel[brand.status] ?? brand.status}</span></div>
    <div className="status-grid"><div><span className="muted">Lifecycle status</span><strong>{statusLabel[state?.lifecycle_status ?? brand.status] ?? brand.status}</strong></div><div><span className="muted">Runtime sync</span><strong>{statusLabel[state?.runtime_sync_status ?? brand.runtime_sync_status] ?? brand.runtime_sync_status}</strong></div></div>
    <div className="form-inline"><button className="primary" onClick={onInstall}>Install</button><button onClick={onRollback}>Rollback</button>{install?.status === "failed" && <button onClick={onRetry}>Retry</button>}</div>
    {install && <div className="section"><h3>Receipts / Errors</h3><p>Status: <code>{install.status}</code> · runtime: <code>{install.runtime_sync_status}</code></p>{install.receipts.map((receipt) => <div className="receipt" key={receipt.step}><span>{receipt.step}</span><span className={`pill ${receipt.status}`}>{receipt.status}</span>{receipt.error && <span className="error">{receipt.error}</span>}</div>)}</div>}
    <div className="section"><h3>Checklist</h3>{checklistItems.map(({ item, label }) => <label className="check-row" key={item}><input type="checkbox" onChange={() => onChecklist(item)} />{label} <span className="muted">({item})</span></label>)}</div>
  </section>;
}
