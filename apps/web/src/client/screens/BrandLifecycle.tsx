import { BRAND_NAME_PATTERN, BrandName, type SealedTemplateVersion, type BrandSummary, type ChecklistEvidence, type ChecklistItemName, type LifecycleBrandSummary, type InstallWithReceipts, type CoreListError, type CoreListErrorCode } from "@anjuna/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { isCurrentOperationResult, isCurrentRefresh, lifecycleMutationAvailability, reduceLifecycleState, shouldRecoverAcceptedInstall, type LifecycleState } from "../lifecycle-state";
import { ConfigPanel } from "./ConfigPanel";
import { UpgradeOutcomes } from "./UpgradeOutcomes";

type InstallHistoryRow = { install_id: string; status: string; error: string | null };

async function installHistory(brandId: string): Promise<InstallHistoryRow[]> {
  const response = await fetch(`/api/brands/${encodeURIComponent(brandId)}/installs`, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body as ApiError["body"]);
  return (body as { installs: InstallHistoryRow[] }).installs;
}

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

const coreListLabel: Record<CoreListErrorCode, string> = {
  core_binding_missing: "ไม่พบการเชื่อมต่อ Core lifecycle (Core lifecycle binding is missing)",
  core_list_fetch_failed: "ดึงรายการแบรนด์จาก Core ไม่สำเร็จ (Core brand list fetch failed)",
  core_list_response_invalid: "ข้อมูลรายการแบรนด์จาก Core ไม่ถูกต้อง (Core brand list response is invalid)",
  core_list_account_missing: "ยังไม่ได้ตั้งค่าบัญชีสำหรับรายการแบรนด์ Core (Core brand list account is not configured)",
};

export function BrandLifecycle({ me }: { me: Me }) {
  const [templates, setTemplates] = useState<SealedTemplateVersion[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [brands, setBrands] = useState<LifecycleBrandSummary[]>([]);
  const [runtimeBrands, setRuntimeBrands] = useState<BrandSummary[]>([]);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [coreListError, setCoreListError] = useState<CoreListError | null>(null);
  const [upgradeRefresh, setUpgradeRefresh] = useState(0);
  const [configBrandId, setConfigBrandId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<LifecycleState>();
  const [install, setInstall] = useState<InstallWithReceipts | undefined>();
  const [installError, setInstallError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [pendingOperation, setPendingOperation] = useState<{ brandId: string; generation: number; installId: string } | null>(null);
  const [checklist, setChecklist] = useState<Record<ChecklistItemName, ChecklistEvidence | undefined>>({} as Record<ChecklistItemName, ChecklistEvidence | undefined>);
  const [leadId, setLeadId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const operationGeneration = useRef(0);
  const [draft, setDraft] = useState({ name: "", domain: "", keyword_default: "", template_version_id: "" });
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [upgrade, setUpgrade] = useState({ from_template_version_id: "", to_template_version_id: "", form_artifact_id: "", canary_brand_id: "" });

  useEffect(() => {
    let active = true;
    setTemplatesLoading(true);
    setTemplatesError(null);
    void api.sealedTemplates().then(({ templates: next }) => {
      if (!active) return;
      setTemplates(next);
      setDraft((previous) => ({ ...previous, template_version_id: next.some((t) => t.template_version_id === previous.template_version_id) ? previous.template_version_id : "" }));
    }, () => {
      if (!active) return;
      setTemplates([]);
      setTemplatesError("โหลด sealed templates ไม่สำเร็จ กรุณารีเฟรช");
    }).finally(() => { if (active) setTemplatesLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  const nameValid = BrandName.safeParse(draft.name).success;
  const canCreateDraft = !creatingDraft && !templatesLoading && !templatesError && nameValid &&Boolean(draft.domain.trim()) && Boolean(draft.keyword_default.trim()) && templates.some((t) => t.template_version_id === draft.template_version_id);

  const load = useCallback(async (token = { selectedId, generation: operationGeneration.current }) => {
    try {
      const [lifecycle, runtime] = await Promise.allSettled([api.lifecycleBrands(), api.brands()]);
      if (!isCurrentRefresh(token.selectedId, token.generation, selectedId, operationGeneration.current)) return;
      if (lifecycle.status === "rejected") throw lifecycle.reason;
      const result = lifecycle.value;
      setBrands(result.brands);
      setCoreListError(result.core_error ?? null);
      if (runtime.status === "fulfilled") {
        setRuntimeBrands(runtime.value.brands);
        setRuntimeError(null);
      } else {
        setRuntimeError("โหลด runtime config ไม่สำเร็จ กรุณารีเฟรช");
      }
      if (!selectedId && result.brands[0]) setSelectedId(result.brands[0].brand_id);
    } catch (e) {
      if (isCurrentRefresh(token.selectedId, token.generation, selectedId, operationGeneration.current)) {
        setError(e instanceof ApiError ? e.thai : "โหลด lifecycle ไม่สำเร็จ");
      }
    }
  }, [selectedId]);
  const selected = useMemo(() => brands.find((b) => b.brand_id === selectedId), [brands, selectedId]);
  useEffect(() => {
    let active = true;
    operationGeneration.current += 1;
    setState(undefined);
    setInstall(undefined);
    setInstallError(null);
    setPendingOperation(null);
    setConfigBrandId(null);
    setChecklist({} as Record<ChecklistItemName, ChecklistEvidence | undefined>);
    setLeadId("");
    if (!selected) { setRecovering(false); return () => { active = false; }; }
    setRecovering(true);
    const token = operationToken();
    setState(reduceLifecycleState(undefined, { type: "brand", brand: selected }));
    void api.checklist(selected.brand_id).then((result) => {
      if (!active) return;
      const next = {} as Record<ChecklistItemName, ChecklistEvidence | undefined>;
      for (const row of result.checklist) next[row.item] = row.evidence as ChecklistEvidence;
      setChecklist(next);
    }, () => undefined);
    void (async () => {
      try {
        const history = await installHistory(selected.brand_id);
        if (!active || !canCommit(token, selected.brand_id)) return;
        // The API returns newest first. An active operation takes precedence
        // over terminal history; otherwise show the latest attempt, even if
        // a dispatch failure left the factory brand live or draft.
        const latest = history.find((row) => row.status === "queued" || row.status === "running") ?? history[0];
        if (!latest) return;
        setInstallError(latest.error);
        setPendingOperation({ brandId: selected.brand_id, generation: token.generation, installId: latest.install_id });
        const detail = await api.installDetail(latest.install_id);
        if (active && detail.install_id === latest.install_id) commitInstallDetail(detail, token);
      } catch (e) {
        if (active && canCommit(token, selected.brand_id)) setError(e instanceof ApiError ? e.thai : "โหลดประวัติ install ไม่สำเร็จ");
      } finally {
        if (active && canCommit(token, selected.brand_id)) setRecovering(false);
      }
    })();
    return () => { active = false; };
  }, [selected?.brand_id, refresh]);
  useEffect(() => { void load(); }, [load, refresh]);
  useEffect(() => {
    const pending = pendingOperation && pendingOperation.brandId === selectedId && pendingOperation.generation === operationGeneration.current
      ? pendingOperation
      : undefined;
    if (!shouldRecoverAcceptedInstall(pending?.brandId, pending?.installId, selectedId, install, state)) return;
    if (!selectedId) return;
    // Once a newer dispatch is accepted, always poll that accepted operation;
    // the displayed install may still be an older terminal attempt.
    const installId = pending!.installId;
    const token = { selectedId, generation: operationGeneration.current };
    let active = true;
    let attempts = 0;
    const maxAttempts = 120;
    const timer = window.setInterval(() => { void api.installDetail(installId).then((next) => {
      attempts += 1;
      if (!active || !canCommit(token, next.brand_id) || next.install_id !== installId) return;
      commitInstallDetail(next, token);
      if (next.status !== "queued" && next.status !== "running") void load(token);
    }, () => {
      attempts += 1;
      if (active && attempts >= maxAttempts && canCommit(token, selectedId)) {
        setPendingOperation(null);
        setError("ติดตาม lifecycle ไม่สำเร็จภายในเวลาที่กำหนด");
      }
    }); }, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [install, pendingOperation, selectedId, state, load]);

  function operationToken() {
    return { selectedId, generation: operationGeneration.current };
  }
  function canCommit(token: { selectedId: string | null; generation: number }, resultBrandId: string) {
    return isCurrentOperationResult(token.selectedId, token.generation, selectedId, operationGeneration.current, resultBrandId);
  }
  function commitInstallDetail(detail: InstallWithReceipts, token: { selectedId: string | null; generation: number }, retry?: { install_id: string; compensation_install_id?: string }) {
    if (!canCommit(token, detail.brand_id)) return false;
    setInstall(detail);
    if (detail.status !== "queued" && detail.status !== "running") setPendingOperation(null);
    setState((previous) => {
      const next = reduceLifecycleState(previous, { type: "install", install: detail });
      return retry ? reduceLifecycleState(next, { type: "retry", ...retry }) : next;
    });
    return true;
  }
  async function act(action: () => Promise<unknown>) {
    const token = operationToken();
    try {
      setError(null);
      await action();
      await load(token);
    } catch (e) {
      if (isCurrentRefresh(token.selectedId, token.generation, selectedId, operationGeneration.current)) {
        setError(e instanceof ApiError ? e.thai : "ดำเนินการไม่สำเร็จ");
      }
    }
  }
  async function createDraft() {
    if (!canCreateDraft) return;
    setCreatingDraft(true);
    try {
      await act(async () => {
        const result = await api.createDraft({ ...draft, name: draft.name.trim() });
        setSelectedId(result.brand.brand_id);
        setDraft({ name: "", domain: "", keyword_default: "", template_version_id: "" });
      });
    } finally {
      setCreatingDraft(false);
    }
  }
  async function dispatchOperation(action: () => Promise<{ install_id: string }>, retryOf?: string) {
    if (!selected) return;
    operationGeneration.current += 1;
    const token = operationToken();
    let installId: string | undefined;
    setRecovering(true);
    try {
      setError(null);
      setInstallError(null);
      const result = await action();
      installId = result.install_id;
      if (canCommit(token, selected.brand_id)) setPendingOperation({ brandId: selected.brand_id, generation: token.generation, installId: result.install_id });
      const detail = await api.installDetail(result.install_id);
      if (detail.install_id === installId && commitInstallDetail(detail, token, retryOf ? { install_id: retryOf, compensation_install_id: installId } : undefined)) await load(token);
    } catch (e) {
      if (!canCommit(token, selected.brand_id)) return;
      // A rejected dispatch still creates an install row. Preserve its ID and
      // recover its failed detail so Retry is reachable without a reload.
      const failure = e instanceof ApiError ? e.body as (ApiError["body"] & { install_id?: unknown; active_install_id?: unknown }) : null;
      const failedId = failure?.install_id ?? failure?.active_install_id;
      const message = failure?.message ?? (e instanceof ApiError ? e.thai : "ดำเนินการไม่สำเร็จ");
      setError(message);
      if (!installId && typeof failedId === "string") {
        installId = failedId;
        setError(null);
        setInstallError(message);
        setPendingOperation({ brandId: selected.brand_id, generation: token.generation, installId });
        try {
          const detail = await api.installDetail(installId);
          if (detail.install_id === installId) commitInstallDetail(detail, token);
        } catch { /* The existing poll recovers a transient detail failure. */ }
      } else if (!installId) setPendingOperation(null);
    } finally {
      if (canCommit(token, selected.brand_id)) setRecovering(false);
    }
  }
  async function rollback() {
    if (!selected) return;
    await dispatchOperation(() => api.rollbackLifecycle(selected.brand_id));
  }
  async function startInstall() {
    if (!selected) return;
    await dispatchOperation(() => api.install(selected.brand_id, selected.current_revision_id ?? undefined));
  }
  async function retry() {
    if (!selected || !install) return;
    await dispatchOperation(async () => { const accepted = await api.retryInstall(install.install_id); setUpgradeRefresh((value) => value + 1); return accepted; }, install.install_id);
  }
  async function recover() {
    if (!selected) return;
    await dispatchOperation(() => api.recover(selected.brand_id));
  }

  const runtimeBrand = runtimeBrands.find((brand) => brand.brand_id === selectedId);

  return <div className="lifecycle-grid">
    <section className="card lifecycle-list">
      <div className="row split"><h1>Lifecycle แบรนด์</h1></div>
      {error && <div className="error" role="alert">{error}</div>}
      <button onClick={() => { setError(null); setRefresh((value) => value + 1); }}>รีเฟรช (Refresh)</button>
      <form className="section" onSubmit={(e) => { e.preventDefault(); void createDraft(); }}>
        <h3>เพิ่มแบรนด์ (Domain + Keyword + Template)</h3>
        <label>ชื่อแบรนด์ (Brand name)<input required maxLength={60} pattern={BRAND_NAME_PATTERN} aria-describedby="brand-name-hint" aria-invalid={Boolean(draft.name.trim()) && !nameValid} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Level Lending" /></label>
        <small id="brand-name-hint" className="muted">ตัวอักษร ตัวเลข ช่องว่าง และ &amp; . ' - ไม่เกิน 60 ตัว (Letters, digits, space, &amp; . ' -, up to 60)</small>
        {Boolean(draft.name.trim()) && !nameValid && <p className="error small" role="alert">ชื่อแบรนด์ไม่ถูกต้อง (Invalid brand name)</p>}
        <label>โดเมน (Domain)<input required value={draft.domain} onChange={(e) => setDraft({ ...draft, domain: e.target.value })} placeholder="example.com" /></label>
        <label>คีย์เวิร์ด (Keyword)<input required value={draft.keyword_default} onChange={(e) => setDraft({ ...draft, keyword_default: e.target.value })} placeholder="Fast cash" /></label>
        <label>เวอร์ชันเทมเพลต (Sealed template version)<select required disabled={templatesLoading || templates.length === 0} value={draft.template_version_id} onChange={(e) => setDraft({ ...draft, template_version_id: e.target.value })}>
          <option value="">{templatesLoading ? "กำลังโหลดเทมเพลต…" : "เลือกเทมเพลต (sealed template)"}</option>
          {templates.map((template) => <option key={template.template_version_id} value={template.template_version_id}>{template.name} · v{template.version} ({template.template_version_id})</option>)}
        </select></label>
        {templatesError && <p className="error" role="alert">{templatesError}</p>}
        {!templatesLoading && !templatesError && templates.length === 0 && <p role="status">ยังไม่มี sealed template กรุณาให้ Owner seal เทมเพลตก่อน</p>}
        <button className="primary" type="submit" disabled={!canCreateDraft}>สร้างแบรนด์ (Create draft)</button>
      </form>
      <div className="lifecycle-brand-list"><h3>สถานะ (Lifecycle status)</h3>{brands.map((brand) => <button key={brand.brand_id} className={brand.brand_id === selectedId ? "lifecycle-brand selected" : "lifecycle-brand"} onClick={() => setSelectedId(brand.brand_id)}><span><b>{brand.name ?? brand.hostnames[0] ?? brand.brand_id}</b>{brand.name && <small className="muted"> {brand.hostnames[0]}</small>}</span><span>{statusLabel[brand.status] ?? brand.status}</span></button>)}</div>
      <p className="muted small">การทำงาน (Actions): Install · Rollback · Retry · Recover · Test sold</p>
    </section>
    {selected && <LifecycleDetail me={me} brand={selected} state={state} install={install} pendingOperation={recovering || (pendingOperation?.brandId === selected.brand_id && pendingOperation.generation === operationGeneration.current)} checklist={checklist} leadId={leadId} onLeadIdChange={setLeadId} onInstall={() => void startInstall()} onRollback={() => void rollback()} onRetry={() => void retry()} onRecover={() => void recover()} onChecklist={async (item, suppliedLeadId) => { const token = operationToken(); try { const result = await api.attestChecklist(selected.brand_id, item, suppliedLeadId); if (!canCommit(token, selected.brand_id)) return; const row = (result as { evidence?: ChecklistEvidence }).evidence; if (row) setChecklist((previous) => ({ ...previous, [item]: row })); await load(token); } catch (e) { if (canCommit(token, selected.brand_id)) setError(e instanceof ApiError ? e.thai : "ดำเนินการไม่สำเร็จ"); } }} />}
    {pendingOperation?.brandId === selectedId && <p role="status">Install ID: <code>{pendingOperation.installId}</code> · กำลังติดตามสถานะ</p>}
    {installError && <p className="error" role="alert">{installError}</p>}
    {runtimeError && <p className="error" role="alert">{runtimeError}</p>}
    {coreListError && <p className="error" role="alert">{coreListLabel[coreListError.code] ?? coreListError.message}. ใช้รายการแบรนด์จาก Core ไม่ได้ จึงแสดงเฉพาะแบรนด์จาก factory (Core brand list is unavailable) กรุณารีเฟรชเพื่อลองใหม่</p>}
    {runtimeBrand && <section className="card" aria-label="Runtime config and statistics">
      <h2>การตั้งค่า runtime (Runtime config)</h2>
      <p>สถานะ runtime: {runtimeBrand.status}</p>
      <p>สถิติ 7 วัน · ลีด (Leads): {runtimeBrand.stats_7d.leads} · ขายได้ (Sold): {runtimeBrand.stats_7d.sold} · รอผล (Pending): {runtimeBrand.stats_7d.pending}</p>
      <button onClick={() => setConfigBrandId(runtimeBrand.brand_id)}>ตั้งค่าแบรนด์ (Runtime config)</button>
    </section>}
    {configBrandId && configBrandId === selectedId && runtimeBrand && <ConfigPanel key={configBrandId} me={me} brandId={configBrandId} onClose={() => setConfigBrandId(null)} onChanged={() => void load()} />}
    {me.role === "owner" && <section className="card upgrade-card"><h2>อัปเกรดทุกแบรนด์ (Upgrade-all, Owner เท่านั้น)</h2><p className="muted">อัปเกรดแบบ canary ก่อน; target artifact ต้องมี payload <code>2026-01</code> และ bundle identity แยกเป็น <code>form@…</code></p><div className="form-inline">{Object.entries(upgrade).map(([key, value]) => <input key={key} aria-label={key} placeholder={key} value={value} onChange={(e) => setUpgrade({ ...upgrade, [key]: e.target.value })} />)}<button className="danger" onClick={() => void act(async () => { await api.upgradeAll(upgrade); setUpgradeRefresh((value) => value + 1); })}>เริ่ม Upgrade-all</button></div></section>}
    {me.role === "owner" && <UpgradeOutcomes refresh={refresh + upgradeRefresh} />}
  </div>;
}

export function LifecycleDetail({ me, brand, state, install, pendingOperation = false, checklist, leadId, onLeadIdChange, onInstall, onRollback, onRetry, onRecover, onChecklist }: { me: Me; brand: LifecycleBrandSummary; state?: LifecycleState; install?: InstallWithReceipts; pendingOperation?: boolean; checklist: Partial<Record<ChecklistItemName, ChecklistEvidence | undefined>>; leadId: string; onLeadIdChange: (value: string) => void; onInstall: () => void; onRollback: () => void; onRetry: () => void; onRecover: () => void; onChecklist: (item: ChecklistItemName, leadId?: string) => void }) {
  const lifecycleStatus = state?.lifecycle_status ?? (brand.status === "installing" ? "running" : brand.status === "live" ? "ready" : brand.status);
  const actions = lifecycleMutationAvailability(brand.status, install?.status, pendingOperation, install?.recovery_required === true);
  const isManaged = brand.status !== "unmanaged";
  const missingArtifact = brand.bundle_form_version == null || brand.payload_version == null;
  return <section className="card lifecycle-detail"><div className="row split"><div><h2>{brand.name ?? brand.hostnames[0] ?? brand.brand_id}</h2><p className="muted">{brand.name && `${brand.hostnames[0]} · `}{brand.brand_id} · form <code>{brand.bundle_form_version ?? "—"}</code> · payload <code>{brand.payload_version ?? "—"}</code></p></div><span className={`pill ${brand.status}`}>{statusLabel[brand.status] ?? brand.status}</span></div>
    <div className="status-grid"><div><span className="muted">สถานะ lifecycle</span><strong>{statusLabel[lifecycleStatus] ?? lifecycleStatus}</strong></div><div><span className="muted">การซิงก์ runtime</span><strong>{statusLabel[state?.runtime_sync_status ?? brand.runtime_sync_status] ?? brand.runtime_sync_status}</strong></div></div>
    {isManaged && <div className="form-inline">{actions.install && <button className="primary" disabled={missingArtifact} onClick={onInstall}>ติดตั้ง (Install)</button>}{me.role === "owner" && actions.rollback && <button onClick={onRollback}>ย้อนกลับ (Rollback)</button>}{actions.retry && <button onClick={onRetry}>ลองใหม่ (Retry)</button>}{actions.recover && me.role === "owner" && <button className="danger" onClick={onRecover}>กู้คืน (Recover, Owner)</button>}{actions.install && missingArtifact && <p className="muted small" role="note">ติดตั้งไม่ได้: แบรนด์นี้ยังไม่มี form artifact ที่ยืนยันแล้ว</p>}</div>}
    {install && <div className="section"><h3>ผลการทำงานและข้อผิดพลาด (Receipts / Errors)</h3><p>Install ID: <code>{install.install_id}</code></p><p>สถานะ: <code>{install.status}</code> · runtime: <code>{install.runtime_sync_status}</code></p>{install.receipts.map((receipt) => <div className="receipt" key={receipt.step}><span>{receipt.step}</span><span className={`pill ${receipt.status}`}>{receipt.status}</span>{receipt.error && <span className="error">{receipt.error}</span>}</div>)}</div>}
    <div className="section"><h3>รายการตรวจ (Checklist)</h3>{checklistItems.map(({ item, label }) => {
      const evidence = checklist[item];
      const isSold = item === "test_sold";
      return <div className="check-row" key={item}><label><input type="checkbox" checked={Boolean(evidence)} disabled={Boolean(evidence)} onChange={() => onChecklist(item, isSold ? leadId : undefined)} />{label} <span className="muted">({item})</span></label>{isSold && !evidence && <input aria-label="lead_id" placeholder="opaque lead_id" value={leadId} onChange={(e) => onLeadIdChange(e.target.value)} required />}{evidence && <span className="muted small">หลักฐาน: {evidence.actor_id} · {evidence.verified_at}{"event_id" in evidence ? ` · event ${evidence.event_id}` : ""}</span>}</div>;
    })}</div>
  </section>;
}
