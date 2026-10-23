import { type BrandRevisionsResponse, type BrandSummary, type ChecklistEvidence, type ChecklistItemName, type LifecycleBrandSummary, type InstallWithReceipts, type CoreListError, type CoreListErrorCode } from "@anjuna/contracts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { isCurrentOperationResult, isCurrentRefresh, lifecycleMutationAvailability, reduceLifecycleState, shouldRecoverAcceptedInstall, type LifecycleState } from "../lifecycle-state";
import { type ConfirmOptions, useConfirm } from "../components/ConfirmDialog";
import { InstallProgress } from "../components/InstallProgress";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { flowGateLabel, operationLabel, statusBadgeTone, statusLabel } from "../labels";
import { DuplicateDialog } from "../wizard/DuplicateDialog";
import { EmptyState } from "../components/EmptyState";
import { finalUrl, siteUrl } from "../final-url";
import { BRAND_CHIPS, brandHealth, matchesBrandChip, matchesBrandSearch, sortBrands, type BrandChip, type BrandSortMode } from "../brand-health";
import { BRAND_PERIODS, BrandStatsRow, brandMoney, brandStats, usePeriodFunnel, useSpendReport, useWeekFunnel, type BrandPeriod } from "./BrandStatsRow";
import { BrandFilters } from "./BrandFilters";
import { BrandWizard } from "./BrandWizard";
import { ConfigPanel } from "./ConfigPanel";
import { UpgradeOutcomes } from "./UpgradeOutcomes";
import "./Brands.css";

type InstallHistoryRow = { install_id: string; status: string; error: string | null };

async function installHistory(brandId: string): Promise<InstallHistoryRow[]> {
  const response = await fetch(`/api/brands/${encodeURIComponent(brandId)}/installs`, { credentials: "same-origin" });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body as ApiError["body"]);
  return (body as { installs: InstallHistoryRow[] }).installs;
}

// Only Test sold is a manual action (a verified lead_id). The other rows are computed by the server:
// drain_route from the Core route, leadsgate_postbacks from the tenant token, final_url from the install smoke step.
const checklistItems: Array<{ item: ChecklistItemName; label: string; pending?: string }> = [
  { item: "drain_route", label: "Drain route", pending: "อัตโนมัติเมื่อ Owner ตั้ง Google Ads account และ conversion action (Automatic once the Owner sets the Google Ads account and conversion action)" },
  { item: "leadsgate_postbacks", label: "LeadsGate postbacks", pending: "อัตโนมัติเมื่อ Core ใช้ postback token ของ tenant (Automatic when Core uses the tenant postback token)" },
  { item: "test_sold", label: "ยืนยัน Test sold (Confirm test sold)" },
  { item: "final_url", label: "Final URL suffix keyword={keyword}", pending: "อัตโนมัติเมื่อ smoke test ของการติดตั้งผ่าน (Automatic when the install smoke test passes)" },
];

/** A whole number with thousands separators. An unknown number is "—". */
const count = (value: number | null) => (value === null ? "—" : Math.round(value).toLocaleString("en-US"));
/** Dollars: whole dollars from 100 up, cents below. An unknown amount is "—". */
function usd(value: number | null): string {
  if (value === null) return "—";
  const text = Math.abs(value) >= 100 || Number.isInteger(value) ? Math.round(Math.abs(value)).toLocaleString("en-US") : Math.abs(value).toFixed(2);
  return `${value < 0 ? "−$" : "$"}${text}`;
}

const coreListLabel: Record<CoreListErrorCode, string> = {
  core_binding_missing: "ไม่พบการเชื่อมต่อ Core lifecycle (Core lifecycle binding is missing)",
  core_list_fetch_failed: "ดึงรายการแบรนด์จาก Core ไม่สำเร็จ (Core brand list fetch failed)",
  core_list_response_invalid: "ข้อมูลรายการแบรนด์จาก Core ไม่ถูกต้อง (Core brand list response is invalid)",
  core_list_account_missing: "ยังไม่ได้ตั้งค่าบัญชีสำหรับรายการแบรนด์ Core (Core brand list account is not configured)",
};

/**
 * wizardRequest: a counter the app raises to open the New brand wizard from its menu.
 * wizardRoute: true while the URL is /brands/new, so back and forward open and close the wizard.
 * routeBrandId: the brand id in the URL path; onSelectBrand and onWizardClosed keep the URL in step with the screen.
 * onNewBrand: the app opens /brands/new for the New brand button, so the wizard has a URL. Without it the button opens the wizard here.
 */
export function BrandLifecycle({ me, wizardRequest = 0, wizardRoute = false, routeBrandId, onSelectBrand, onWizardClosed, onNewBrand }: {
  me: Me;
  wizardRequest?: number;
  wizardRoute?: boolean;
  routeBrandId?: string | null;
  onSelectBrand?: (brandId: string) => void;
  onWizardClosed?: () => void;
  onNewBrand?: () => void;
}) {
  const [wizard, setWizard] = useState<{ brandId?: string; initialStep?: number } | null>(null);
  const [duplicateOf, setDuplicateOf] = useState<LifecycleBrandSummary | null>(null);
  const [brands, setBrands] = useState<LifecycleBrandSummary[]>([]);
  const [listLoaded, setListLoaded] = useState(false);
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
  // undefined while loading, null when the request failed (a core-only brand has no factory revisions).
  const [revisions, setRevisions] = useState<BrandRevisionsResponse | null | undefined>();
  // The Final URL, shown in a read-only input after the clipboard was missing or refused it.
  const [manualCopyUrl, setManualCopyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Each toast has its own id, which keys the Toast: an equal text from a second action restarts the full countdown.
  const [toast, setToast] = useState<{ id: number; kind: "ok" | "err"; text: string } | null>(null);
  const toastSeq = useRef(0);
  const showToast = (kind: "ok" | "err", text: string) => setToast({ id: (toastSeq.current += 1), kind, text });
  const dismissToast = useCallback(() => setToast(null), []);
  // Brands whose pause or resume request is in flight; the row button stays off so one confirm sends one request.
  const [toggling, setToggling] = useState<ReadonlySet<string>>(new Set());
  const operationGeneration = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // The brand and current_revision_id the latest revisions fetch was issued for, and a sequence number so only the latest fetch commits.
  const revisionsFetch = useRef<{ brandId: string; currentRevisionId: string | null; seq: number } | null>(null);
  const [confirm, confirmDialog, cancelConfirm] = useConfirm();
  const weekFunnel = useWeekFunnel(refresh);
  const [period, setPeriod] = useState<BrandPeriod>("7d");
  // View preferences, not routes: /brands/:id is the only deep link.
  const [chip, setChip] = useState<BrandChip>("all");
  const [sort, setSort] = useState<BrandSortMode>("issues");
  const [search, setSearch] = useState("");
  const owner = me.role === "owner";
  const periodFunnel = usePeriodFunnel(period, refresh, weekFunnel);
  // The spend API answers 403 to an Employee, so only the Owner asks, and only the Owner sees money columns.
  const spend = useSpendReport(period, owner, refresh);
  const [upgrade, setUpgrade] = useState({ from_template_version_id: "", to_template_version_id: "", form_artifact_id: "", canary_brand_id: "" });

  useEffect(() => { if (wizardRequest > 0) setWizard({}); }, [wizardRequest]);
  // The wizard replaces this screen's JSX, which hides {confirmDialog}; close an open question so it cannot come back later.
  useEffect(() => { if (wizard) cancelConfirm(); }, [wizard]);
  // Entering /brands/new shows the new-brand wizard, in place of a resumed draft (brandId set) if one is open.
  // A resumed draft is not the new-brand route, so leaving /brands/new keeps it open.
  useEffect(() => setWizard((w) => (wizardRoute ? (w?.brandId ? {} : (w ?? {})) : w && !w.brandId ? null : w)), [wizardRoute]);
  useEffect(() => {
    if (routeBrandId && routeBrandId !== selectedId) setSelectedId(routeBrandId);
    // The route is the source of truth: a resumed draft stays open only while the URL names its brand. On /brands/new the new-brand wizard takes its place.
    setWizard((w) => (w?.brandId && w.brandId !== routeBrandId ? (wizardRoute ? {} : null) : w));
  }, [routeBrandId]);
  // Back from an unknown brand id: drop the dead selection so load() picks the first brand. It also runs when the list arrives
  // after the route change. A valid selection stays.
  useEffect(() => {
    if (!routeBrandId && listLoaded && selectedId && !brands.some((b) => b.brand_id === selectedId)) setSelectedId(null);
  }, [routeBrandId, listLoaded, brands]);

  const load = useCallback(async (token = { selectedId, generation: operationGeneration.current }) => {
    try {
      const [lifecycle, runtime] = await Promise.allSettled([api.lifecycleBrands(), api.brands()]);
      if (!isCurrentRefresh(token.selectedId, token.generation, selectedId, operationGeneration.current)) return;
      if (lifecycle.status === "rejected") throw lifecycle.reason;
      const result = lifecycle.value;
      setBrands(result.brands);
      setListLoaded(true);
      setCoreListError(result.core_error ?? null);
      if (runtime.status === "fulfilled") {
        setRuntimeBrands(runtime.value.brands);
        setRuntimeError(null);
      } else {
        setRuntimeError("โหลด runtime config ไม่สำเร็จ กรุณารีเฟรช");
      }
      if (!selectedId && !routeBrandId && result.brands[0]) setSelectedId(result.brands[0].brand_id);
    } catch (e) {
      if (isCurrentRefresh(token.selectedId, token.generation, selectedId, operationGeneration.current)) {
        setError(e instanceof ApiError ? e.thai : "โหลด lifecycle ไม่สำเร็จ");
      }
    }
  }, [selectedId]);
  const selected = useMemo(() => brands.find((b) => b.brand_id === selectedId), [brands, selectedId]);
  // A layout effect: the per-brand reset must run in the commit that first shows the brand's controls, before
  // any click can reach them. A passive effect runs after that commit, so a quick click on Runtime config,
  // Install or Redeploy was overwritten by the reset.
  useLayoutEffect(() => {
    let active = true;
    operationGeneration.current += 1;
    // A dialog opened for the previous brand must not stay open over this one.
    cancelConfirm();
    setState(undefined);
    setInstall(undefined);
    setInstallError(null);
    setPendingOperation(null);
    setConfigBrandId(null);
    setChecklist({} as Record<ChecklistItemName, ChecklistEvidence | undefined>);
    setLeadId("");
    setRevisions(undefined);
    setManualCopyUrl(null);
    if (!selected) { setRecovering(false); return () => { active = false; }; }
    setRecovering(true);
    const token = operationToken();
    setState(reduceLifecycleState(undefined, { type: "brand", brand: selected }));
    fetchRevisions(selected.brand_id, selected.current_revision_id, () => active);
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
        // Only an active install is polled. A terminal one is read once below and never polled.
        if (latest.status === "queued" || latest.status === "running") {
          setPendingOperation({ brandId: selected.brand_id, generation: token.generation, installId: latest.install_id });
        }
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
  // A refreshed brand list gives `selected` a new object with the same brand_id; sync the server runtime status without the reset above.
  useEffect(() => {
    if (!selected) return;
    setState((previous) => previous && previous.brand?.brand_id === selected.brand_id ? reduceLifecycleState(previous, { type: "brand_refresh", brand: selected }) : previous);
  }, [selected]);
  useEffect(() => { void load(); }, [load, refresh]);
  // A rollback, redeploy or install moves the brand's current revision without changing the selection: reload so the
  // rollback target named in the confirm is the one the server would pick now.
  // It compares with the value the latest fetch was issued for, not with the loaded data, so a move that lands while the
  // first fetch is in flight still gets one more fetch, and a response that stays behind cannot loop.
  useEffect(() => {
    if (!selected) return;
    const last = revisionsFetch.current;
    if (last && last.brandId === selected.brand_id && last.currentRevisionId === selected.current_revision_id) return;
    let active = true;
    fetchRevisions(selected.brand_id, selected.current_revision_id, () => active);
    return () => { active = false; };
  }, [selected?.brand_id, selected?.current_revision_id]);
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
    // Stop reading at a terminal status even when the answer can no longer be shown (operator moved on, newer
    // operation): only a re-render with a still-pending install starts a new timer.
    const stop = () => { active = false; window.clearInterval(timer); };
    const timer = window.setInterval(() => { void api.installDetail(installId).then((next) => {
      attempts += 1;
      if (!active) return;
      const terminal = next.install_id === installId && (next.status === "ready" || next.status === "failed" || next.status === "rolled_back");
      if (terminal || attempts >= maxAttempts) stop();
      if (!canCommit(token, next.brand_id) || next.install_id !== installId) return;
      commitInstallDetail(next, token);
      if (terminal) void load(token);
    }, () => {
      attempts += 1;
      if (!active || attempts < maxAttempts) return;
      stop();
      if (canCommit(token, selectedId)) {
        setPendingOperation(null);
        setError("ติดตาม lifecycle ไม่สำเร็จภายในเวลาที่กำหนด");
      }
    }); }, 3000);
    return stop;
  }, [install, pendingOperation, selectedId, state, load]);

  function fetchRevisions(brandId: string, currentRevisionId: string | null, isActive: () => boolean) {
    const seq = (revisionsFetch.current?.seq ?? 0) + 1;
    revisionsFetch.current = { brandId, currentRevisionId, seq };
    const latest = () => isActive() && revisionsFetch.current?.seq === seq;
    void api.brandRevisions(brandId).then((result) => { if (latest()) setRevisions(result); }, () => { if (latest()) setRevisions(null); });
  }
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
  /** Asks first. False when declined, or when the brand changed while the dialog was open (the generation moved on). */
  async function confirmForBrand(options: ConfirmOptions): Promise<boolean> {
    const generation = operationGeneration.current;
    const ok = await confirm(options);
    return ok && operationGeneration.current === generation;
  }
  async function rollback() {
    if (!selected) return;
    const brandId = selected.brand_id;
    const loaded = revisions?.brand_id === brandId ? revisions : undefined;
    const targetId = loaded?.rollback_target_revision_id ?? null;
    const target = targetId ? loaded?.revisions.find((r) => r.revision_id === targetId) : undefined;
    const body = !loaded ? "ยังไม่ทราบเวอร์ชันเป้าหมายของการย้อนกลับ (Rollback target unknown: the revision history is loading or could not be loaded)."
      : !targetId ? "ไม่มีเวอร์ชันเป้าหมายให้ย้อนกลับ (No rollback target for this brand)."
      : `ย้อนกลับแบรนด์ไปที่เวอร์ชัน ${target ? `#${target.revision} ` : ""}(${targetId}) (Roll the brand back to revision ${target ? `#${target.revision} ` : ""}(${targetId})).`;
    const ok = await confirmForBrand({
      title: "ย้อนกลับแบรนด์นี้เป็นเวอร์ชันก่อนหน้า?",
      body,
      confirmLabel: "ย้อนกลับ (Rollback)",
      tone: "danger",
    });
    if (!ok) return;
    await dispatchOperation(() => api.rollbackLifecycle(brandId));
  }
  async function copyFinalUrl() {
    if (!selected) return;
    const url = finalUrl(selected.hostnames);
    if (!url) return;
    const brandId = selected.brand_id;
    const domain = selected.hostnames[0];
    // jsdom and a non-HTTPS origin have no navigator.clipboard, and a present one can still reject (permission, focus).
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) throw new Error("clipboard unavailable");
      await clipboard.writeText(url);
      // An install or rollback bumps operationGeneration for the same brand; only a brand change makes the result stale.
      if (selectedIdRef.current !== brandId) return;
      setManualCopyUrl(null);
      showToast("ok", `คัดลอก Final URL ของ ${domain} แล้ว (Copied the Final URL for ${domain})`);
    } catch {
      if (selectedIdRef.current !== brandId) return;
      setManualCopyUrl(url);
      showToast("err", `คัดลอกอัตโนมัติไม่ได้ กรุณาคัดลอก Final URL ของ ${domain} จากช่องข้างปุ่มเอง (Could not copy; copy the Final URL from the field by hand)`);
    }
  }
  // Pause lives in core and the factory brand stays live, so a paused brand can be redeployed; it stays paused.
  function pausedNote() {
    return runtimeBrands.find((brand) => brand.brand_id === selectedId)?.status === "paused" ? "\n\nแบรนด์นี้ยังคงหยุดชั่วคราว (The brand stays paused.)" : "";
  }
  async function redeploy() {
    if (!selected) return;
    const brandId = selected.brand_id;
    const ok = await confirmForBrand({
      title: "ติดตั้งแบรนด์นี้ใหม่ด้วยเวอร์ชันเทมเพลตและ form ปัจจุบัน?",
      body: `Redeploy at the current template version and form. If a step fails, it rolls back to the previous version.${pausedNote()}`,
      confirmLabel: "ติดตั้งใหม่ (Redeploy)",
    });
    if (!ok) return;
    await dispatchOperation(() => api.redeploy(brandId));
  }
  async function redeployLatest() {
    const target = selected?.newer_form;
    if (!selected || !target) return;
    const brandId = selected.brand_id;
    const ok = await confirmForBrand({
      title: `ติดตั้งแบรนด์นี้ใหม่พร้อมฟอร์ม ${target.bundle_form_version} แทน ${selected.bundle_form_version ?? "—"}?`,
      body: `Redeploy with form ${target.bundle_form_version}, replacing ${selected.bundle_form_version ?? "the current form"}. If a step fails, it rolls back to the previous version and form.${pausedNote()}`,
      confirmLabel: "ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)",
    });
    if (!ok) return;
    await dispatchOperation(() => api.redeploy(brandId, target.form_artifact_id));
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
    const brandId = selected.brand_id;
    const ok = await confirmForBrand({
      title: "กู้คืนแบรนด์นี้?",
      body: "Recover runs the compensation install for this brand.",
      confirmLabel: "กู้คืน (Recover)",
      tone: "danger",
    });
    if (!ok) return;
    await dispatchOperation(() => api.recover(brandId));
  }

  /** Pause or resume from the table row. The confirm text matches the ConfigPanel button. */
  async function toggleStatus(runtime: BrandSummary) {
    const pausing = runtime.status === "live";
    const ok = await confirm({
      title: pausing ? "หยุดแบรนด์นี้ชั่วคราว?" : "เปิดแบรนด์นี้ต่อ?",
      body: pausing ? "Pause stops new leads on this brand until it is resumed." : "Resume starts taking leads again.",
      confirmLabel: pausing ? "หยุดชั่วคราว (Pause)" : "เปิดใช้งานต่อ (Resume)",
      tone: pausing ? "danger" : "default",
    });
    if (!ok) return;
    const brandId = runtime.brand_id;
    setToggling((previous) => new Set(previous).add(brandId));
    try {
      await api.setStatus(brandId, pausing ? "pause" : "resume");
      showToast("ok", pausing ? "หยุดแบรนด์แล้ว" : "เปิดแบรนด์แล้ว");
      await load();
    } catch (e) {
      showToast("err", e instanceof ApiError ? e.thai : "ไม่สำเร็จ");
    } finally {
      setToggling((previous) => {
        const next = new Set(previous);
        next.delete(brandId);
        return next;
      });
    }
  }

  async function startUpgradeAll() {
    const ok = await confirm({
      title: "เริ่มอัปเกรดทุกแบรนด์?",
      body: `Upgrade every brand from ${upgrade.from_template_version_id || "—"} to ${upgrade.to_template_version_id || "—"}, canary ${upgrade.canary_brand_id || "—"} first.`,
      confirmLabel: "เริ่มอัปเกรด (Start upgrade)",
      tone: "danger",
    });
    if (!ok) return;
    await act(async () => { await api.upgradeAll(upgrade); setUpgradeRefresh((value) => value + 1); });
  }

  const runtimeBrand = runtimeBrands.find((brand) => brand.brand_id === selectedId);

  // The install the wizard started is picked up by the brand's history recovery, which polls it.
  if (wizard) return <BrandWizard key={wizard.brandId ?? "new"} me={me} brandId={wizard.brandId} initialStep={wizard.initialStep} onClose={() => { setWizard(null); setRefresh((value) => value + 1); onWizardClosed?.(); }} onGenerated={(brandId) => { setWizard(null); setSelectedId(brandId); setRefresh((value) => value + 1); onSelectBrand?.(brandId); }} />;

  const runtimeList = runtimeError ? null : runtimeBrands;
  const tableRows = brands.map((brand) => ({
    brand,
    name: brand.name ?? brand.hostnames[0] ?? brand.brand_id,
    health: brandHealth(brand, runtimeBrands.find((r) => r.brand_id === brand.brand_id)),
    money: brandMoney(brand.brand_id, runtimeList, periodFunnel, spend),
    stats: brandStats(brand.brand_id, runtimeList, weekFunnel),
  }));
  // Chip counts follow the search, so a count never promises rows the search has hidden.
  const searchedRows = tableRows.filter((row) => matchesBrandSearch(row.brand, search));
  const chipCounts = Object.fromEntries(BRAND_CHIPS.map(({ id }) => [id, searchedRows.filter((row) => matchesBrandChip(row.health, row.brand, id)).length])) as Record<BrandChip, number>;
  const sortedRows = sortBrands(
    searchedRows.filter((row) => matchesBrandChip(row.health, row.brand, chip)),
    sort,
    (row) => ({ health: row.health, domain: row.brand.hostnames[0] ?? row.brand.brand_id, profit: row.money.profit }),
  );
  const columns = owner ? 8 : 5;

  return <div className="brands-page">
    <div className="brands-head">
      <div><h1>Lifecycle แบรนด์</h1><p className="brands-sub">{brands.length} แบรนด์ เลือกแถวเพื่อดูและแก้ไข</p></div>
      <div className="brands-actions">
        <div className="seg" role="group" aria-label="ช่วงเวลา">{BRAND_PERIODS.map(([key, label]) => <button key={key} type="button" aria-pressed={period === key} onClick={() => setPeriod(key)}>{label}</button>)}</div>
        <button className="btn" onClick={() => { setError(null); setRefresh((value) => value + 1); }}>รีเฟรช (Refresh)</button>
        <button className="btn pri" onClick={() => (onNewBrand ? onNewBrand() : setWizard({}))}>แบรนด์ใหม่ (New brand)</button>
      </div>
    </div>
    <BrandFilters chip={chip} onChip={setChip} counts={chipCounts} sort={sort} onSort={setSort} owner={owner} search={search} onSearch={setSearch} />
    {error && <div className="error" role="alert">{error}</div>}
    {pendingOperation?.brandId === selectedId && <p role="status">รหัสติดตั้ง (Install ID): <code>{pendingOperation.installId}</code> · กำลังติดตามสถานะ</p>}
    {installError && <p className="error" role="alert">{installError}</p>}
    {runtimeError && <p className="error" role="alert">{runtimeError}</p>}
    {coreListError && <p className="error" role="alert">{coreListLabel[coreListError.code] ?? coreListError.message}. ใช้รายการแบรนด์จาก Core ไม่ได้ จึงแสดงเฉพาะแบรนด์จาก factory (Core brand list is unavailable) กรุณารีเฟรชเพื่อลองใหม่</p>}
    <div className="brands-grid">
      <section className="panel lifecycle-list">
        <div className="tw"><table className="brand-table">
          <thead><tr>
            <th>แบรนด์ (Brand)</th><th>สถานะ (Status)</th><th>โฟลว์ (Flow gate)</th>
            {owner && <th>ค่าโฆษณา (Spend)</th>}
            <th>คลิก (Clicks)</th><th>ลีด (Leads)</th>
            {owner && <><th>ต้นทุน/ลีด (Cost per lead)</th><th>กำไร (Profit)</th></>}
          </tr></thead>
          <tbody>
            {sortedRows.map(({ brand, name, money, stats }) => {
              const isSelected = brand.brand_id === selectedId;
              const select = () => { setSelectedId(brand.brand_id); onSelectBrand?.(brand.brand_id); };
              const runtime = runtimeBrands.find((r) => r.brand_id === brand.brand_id);
              const canToggle = runtime && (runtime.status === "paused" || (runtime.status === "live" && owner));
              // Pause lives in core and the factory brand stays live, so a paused brand's factory status still reads live.
              const badgeStatus = brand.status === "live" && runtime?.status === "paused" ? "paused" : brand.status;
              return <Fragment key={brand.brand_id}>
                <tr className={isSelected ? "click sel" : "click"} onClick={select}>
                  <td><button type="button" className="brand-pick" aria-current={isSelected || undefined}><b>{name}</b>{brand.name && <small className="muted"> {brand.hostnames[0]}</small>}</button></td>
                  <td>
                    <StatusBadge tone={statusBadgeTone[badgeStatus] ?? "mute"} label={statusLabel[badgeStatus] ?? badgeStatus} />
                    {runtime && canToggle && <button type="button" className={runtime.status === "live" ? "btn warn row-action" : "btn pri row-action"} disabled={toggling.has(brand.brand_id)}
                      onClick={(e) => { e.stopPropagation(); void toggleStatus(runtime); }}>
                      {runtime.status === "live" ? "หยุดชั่วคราว (Pause)" : "เปิดใช้งานต่อ (Resume)"}
                    </button>}
                  </td>
                  <td>{runtime ? flowGateLabel[runtime.flow_gate_mode] : "—"}</td>
                  {owner && <td className="blue">{usd(money.spend)}</td>}
                  <td>{count(money.clicks)}</td>
                  <td>{count(money.leads)}</td>
                  {owner && <>
                    <td>{usd(money.costPerLead)}</td>
                    <td className={money.profit === null ? undefined : money.profit < 0 ? "neg" : "pos"}>{usd(money.profit)}</td>
                  </>}
                </tr>
                <tr className={isSelected ? "click sel stats" : "click stats"} onClick={select}><td colSpan={columns}><BrandStatsRow name={name} stats={stats} /></td></tr>
              </Fragment>;
            })}
            {brands.length === 0 && <tr><td colSpan={columns} className="muted">ยังไม่มีแบรนด์ (No brands yet)</td></tr>}
            {brands.length > 0 && sortedRows.length === 0 && <tr><td colSpan={columns}>
              <EmptyState title="ไม่พบแบรนด์ที่ตรงกับตัวกรอง (No brands match the filter)" hint="ลองล้างตัวกรองหรือคำค้นหา (Try clearing the filter or the search)"
                action={<button type="button" className="btn" onClick={() => { setChip("all"); setSearch(""); }}>ล้างตัวกรอง (Clear filter)</button>} />
            </td></tr>}
          </tbody>
        </table></div>
        <p className="muted small">การทำงาน (Actions): Install · Rollback · Retry · Recover · Test sold</p>
        <p className="hint">{owner ? `${sort === "profit" ? "เรียงจากกำไรน้อยที่สุดก่อน " : ""}ค่าโฆษณาจาก AdKit อัปเดตทุกชั่วโมง ` : ""}เครื่องหมาย — คือยังไม่มีข้อมูล</p>
      </section>
      <div className="brands-aside">
        {selected
          ? <LifecycleDetail me={me} brand={selected} state={state} install={install} pendingOperation={recovering || (pendingOperation?.brandId === selected.brand_id && pendingOperation.generation === operationGeneration.current)} checklist={checklist} revisions={revisions} onCopyFinalUrl={() => void copyFinalUrl()} manualCopyUrl={manualCopyUrl} leadId={leadId} onLeadIdChange={setLeadId} onInstall={() => void startInstall()} onRollback={() => void rollback()} onRedeploy={() => void redeploy()} onRedeployLatest={() => void redeployLatest()} onRetry={() => void retry()} onRecover={() => void recover()} onResumeWizard={() => setWizard({ brandId: selected.brand_id })} onDuplicate={() => setDuplicateOf(selected)} onChecklist={async (item, suppliedLeadId) => { const token = operationToken(); try { const result = await api.attestChecklist(selected.brand_id, item, suppliedLeadId); if (!canCommit(token, selected.brand_id)) return; const row = (result as { evidence?: ChecklistEvidence }).evidence; if (row) setChecklist((previous) => ({ ...previous, [item]: row })); await load(token); } catch (e) { if (canCommit(token, selected.brand_id)) setError(e instanceof ApiError ? e.thai : "ดำเนินการไม่สำเร็จ"); } }} />
          // A failed Core list may hide a Core-only brand, so the id is not known to be missing.
          : listLoaded && !coreListError && routeBrandId
            ? <section className="panel brand-side"><p role="alert">ไม่พบแบรนด์ <code>{routeBrandId}</code> (Brand not found)</p></section>
            : <section className="panel brand-side"><p className="muted">เลือกแบรนด์จากตารางเพื่อดูและแก้ไข</p></section>}
        {runtimeBrand && <section className="panel" aria-label="การตั้งค่าและสถิติรันไทม์ (Runtime config and statistics)">
          <h2>การตั้งค่า runtime (Runtime config)</h2>
          <p>สถานะ runtime: {runtimeBrand.status}</p>
          <p>สถิติ 7 วัน · ลีด (Leads): {runtimeBrand.stats_7d.leads} · ขายได้ (Sold): {runtimeBrand.stats_7d.sold} · รอผล (Pending): {runtimeBrand.stats_7d.pending}</p>
          <button className="btn" onClick={() => setConfigBrandId(runtimeBrand.brand_id)}>ตั้งค่าแบรนด์ (Runtime config)</button>
        </section>}
      </div>
    </div>
    {duplicateOf && <DuplicateDialog source={duplicateOf} onClose={() => setDuplicateOf(null)} onDuplicated={(brandId) => { setDuplicateOf(null); setSelectedId(brandId); setWizard({ brandId, initialStep: 0 }); onSelectBrand?.(brandId); }} />}
    {configBrandId && configBrandId === selectedId && runtimeBrand && <ConfigPanel key={configBrandId} me={me} brandId={configBrandId} brandName={selected?.name} onClose={() => setConfigBrandId(null)} onChanged={() => void load()} onOperationStarted={() => setRefresh((value) => value + 1)} />}
    {owner && <section className="panel upgrade-card"><h2>อัปเกรดทุกแบรนด์ (Upgrade-all, Owner เท่านั้น)</h2><p className="muted">อัปเกรดแบบ canary ก่อน; target artifact ต้องมี payload <code>2026-01</code> และ bundle identity แยกเป็น <code>form@…</code></p><div className="form-inline">{Object.entries(upgrade).map(([key, value]) => <input key={key} aria-label={key} placeholder={key} value={value} onChange={(e) => setUpgrade({ ...upgrade, [key]: e.target.value })} />)}<button className="btn danger" onClick={() => void startUpgradeAll()}>เริ่มอัปเกรดทุกแบรนด์ (Start upgrade-all)</button></div></section>}
    {owner && <UpgradeOutcomes refresh={refresh + upgradeRefresh} />}
    {toast && <Toast key={toast.id} kind={toast.kind} text={toast.text} onDismiss={dismissToast} />}
    {confirmDialog}
  </div>;
}

/**
 * revisions: undefined while loading, null when the request failed; a failed load leaves the rest of the panel working.
 * onCopyFinalUrl: omitted by a caller with no clipboard handling, which then gets no Copy button.
 * manualCopyUrl: the Final URL to show in a read-only input once the clipboard was missing or refused it.
 */
export function LifecycleDetail({ me, brand, state, install, pendingOperation = false, checklist, revisions, onCopyFinalUrl, manualCopyUrl, leadId, onLeadIdChange, onInstall, onRollback, onRedeploy, onRedeployLatest, onRetry, onRecover, onResumeWizard, onDuplicate, onChecklist }: { me: Me; brand: LifecycleBrandSummary; state?: LifecycleState; install?: InstallWithReceipts; pendingOperation?: boolean; checklist: Partial<Record<ChecklistItemName, ChecklistEvidence | undefined>>; revisions?: BrandRevisionsResponse | null; onCopyFinalUrl?: () => void; manualCopyUrl?: string | null; leadId: string; onLeadIdChange: (value: string) => void; onInstall: () => void; onRollback: () => void; onRedeploy: () => void; onRedeployLatest?: () => void; onRetry: () => void; onRecover: () => void; onResumeWizard?: () => void; onDuplicate?: () => void; onChecklist: (item: ChecklistItemName, leadId?: string) => void }) {
  const lifecycleStatus = state?.lifecycle_status ?? (brand.status === "installing" ? "running" : brand.status === "live" ? "ready" : brand.status);
  const actions = lifecycleMutationAvailability(brand.status, install?.status, pendingOperation, install?.recovery_required === true);
  const isManaged = brand.status !== "unmanaged";
  const missingArtifact = brand.bundle_form_version == null || brand.payload_version == null;
  const site = siteUrl(brand.hostnames);
  return <section className="panel brand-side lifecycle-detail"><div className="side-head"><div><h2>{brand.name ?? brand.hostnames[0] ?? brand.brand_id}</h2><p className="muted">{brand.name && `${brand.hostnames[0]} · `}{brand.brand_id} · form <code>{brand.bundle_form_version ?? "—"}</code> · payload <code>{brand.payload_version ?? "—"}</code></p></div><StatusBadge tone={statusBadgeTone[brand.status] ?? "mute"} label={statusLabel[brand.status] ?? brand.status} /></div>
    <div className="status-grid"><div><span className="muted">สถานะ lifecycle</span><strong>{statusLabel[lifecycleStatus] ?? lifecycleStatus}</strong></div><div><span className="muted">การซิงก์ runtime</span><strong>{statusLabel[state?.runtime_sync_status ?? brand.runtime_sync_status] ?? brand.runtime_sync_status}</strong></div></div>
    {isManaged && <div className="side-actions">{actions.install && <button className="btn pri" disabled={missingArtifact} onClick={onInstall}>ติดตั้ง (Install)</button>}{me.role === "owner" && actions.rollback && <button className="btn" onClick={onRollback}>ย้อนกลับ (Rollback)</button>}{me.role === "owner" && brand.status === "live" && actions.rollback && <button className="btn" onClick={onRedeploy}>ติดตั้งใหม่ (Redeploy)</button>}{me.role === "owner" && brand.status === "live" && actions.rollback && brand.newer_form && onRedeployLatest && <button className="btn" onClick={onRedeployLatest}>ติดตั้งใหม่พร้อมฟอร์มล่าสุด (Redeploy with latest form)</button>}{actions.recover && me.role === "owner" && <button className="btn danger" onClick={onRecover}>กู้คืน (Recover, Owner)</button>}{onResumeWizard && (brand.status === "draft" || brand.status === "failed") && <button className="btn" onClick={onResumeWizard}>ทำต่อในวิซาร์ด (Resume in wizard)</button>}{onDuplicate && <button className="btn" onClick={onDuplicate}>ทำสำเนา (Duplicate)</button>}{actions.install && missingArtifact && <p className="muted small" role="note">ติดตั้งไม่ได้: แบรนด์นี้ยังไม่มี form artifact ที่ยืนยันแล้ว</p>}</div>}
    {site && <div className="side-actions">
      <a className="btn" href={site} target="_blank" rel="noopener noreferrer">เปิดเว็บไซต์ (Open site)</a>
      {onCopyFinalUrl && <button type="button" className="btn" onClick={onCopyFinalUrl}>คัดลอก Final URL (Copy Final URL)</button>}
      {manualCopyUrl && <input className="final-url-field" readOnly autoFocus aria-label="Final URL" value={manualCopyUrl} onFocus={(e) => e.currentTarget.select()} />}
    </div>}
    {install && <div className="section"><h3>ความคืบหน้าการติดตั้ง (Install progress)</h3><p>รหัสติดตั้ง (Install ID): <code>{install.install_id}</code>{install.operation && ` · ${operationLabel[install.operation]}`}</p><p>สถานะ: <code>{install.status}</code> · runtime: <code>{install.runtime_sync_status}</code></p><InstallProgress install={install} canRetry={actions.retry} onRetry={onRetry} /></div>}
    {revisions !== undefined && <section className="section"><h3>ประวัติเวอร์ชัน (Revision history)</h3>
      {revisions === null ? <p className="muted small">ไม่มีประวัติเวอร์ชัน หรือโหลดไม่สำเร็จ (No revision history, or it could not be loaded)</p>
        : revisions.revisions.length === 0 ? <p className="muted small">ยังไม่มีเวอร์ชัน (No revisions yet)</p>
        : <ul className="revision-list">{revisions.revisions.map((r) => <li key={r.revision_id}>
          <div><b>#{r.revision}</b>{r.is_current && <span className="revision-tag current"> ใช้งานอยู่ (Current)</span>}{r.revision_id === revisions.rollback_target_revision_id && <span className="revision-tag target"> เป้าหมายการย้อนกลับ (Rollback target)</span>}</div>
          <div className="muted small">{r.created_at} · {r.created_by}</div>
          <div className="muted small">template <code>{r.template_version_id}</code> · form <code>{r.bundle_form_version ?? "—"}</code> · worker <code>{r.worker_version_id ?? "—"}</code></div>
        </li>)}</ul>}
    </section>}
    <div className="section"><h3>รายการตรวจ (Checklist)</h3>{checklistItems.map(({ item, label, pending }) => {
      const evidence = checklist[item];
      const isSold = item === "test_sold";
      return <div className="check-row" key={item}><label><input type="checkbox" checked={Boolean(evidence)} disabled={Boolean(evidence) || !isSold} onChange={() => { if (isSold) onChecklist(item, leadId); }} />{label} <span className="muted">({item})</span></label>{isSold && !evidence && <input aria-label="lead_id" placeholder="opaque lead_id" value={leadId} onChange={(e) => onLeadIdChange(e.target.value)} required />}{!isSold && !evidence && pending && <span className="muted small">{pending}</span>}{evidence && <span className="muted small">หลักฐาน: {evidence.actor_id} · {evidence.verified_at}{"event_id" in evidence ? ` · event ${evidence.event_id}` : ""}</span>}</div>;
    })}</div>
  </section>;
}
