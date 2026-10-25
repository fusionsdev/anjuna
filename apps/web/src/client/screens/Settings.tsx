// spec settings: the Owner-only table of every brand's money-routing and A/B settings.
import type { BrandConfig } from "@anjuna/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { BrandLabel } from "../brand-labels";
import { useConfirm } from "../components/ConfirmDialog";
import { DataTable, type Column } from "../components/DataTable";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { Toast } from "../components/Toast";
import { statusBadgeTone, statusLabel } from "../labels";
import { navigate, setLeaveGuard } from "../router";
import {
  SETTINGS_LABELS,
  buildPatch,
  diffRows,
  draftFromBrand,
  formatSetting,
  isDirty,
  rebaseDraft,
  redrawsVisitors,
  touchesMoney,
  type SettingsDraft,
} from "../settings-draft";
import { SettingsEditor, type EditorBanner } from "./SettingsEditor";
import type { SettingsRow } from "../../shared/settings";
import "./Settings.css";

const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

const NONE = "—";

const CONFLICT_TEXT = "มีคนแก้ไขแบรนด์นี้หลังจากคุณเปิด โหลดค่าล่าสุดแล้ว ตรวจการแก้ไขแล้วบันทึกอีกครั้ง (Someone changed this brand after you opened it. The latest values are loaded; review your edits and save again.)";

export function SettingsScreen() {
  const [rows, setRows] = useState<SettingsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The brand id whose row drawer is open.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [banner, setBanner] = useState<EditorBanner | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok"; text: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  // Only the newest request may write state: Retry or an unmount must not let an older answer land late.
  const latest = useRef(0);
  const load = useCallback(() => {
    const id = ++latest.current;
    setError(null);
    setRows(null);
    api.settingsBrands().then(
      (r) => { if (id === latest.current) setRows(r.rows); },
      (e: unknown) => { if (id === latest.current) setError(e instanceof ApiError ? e.thai : "โหลดตั้งค่าแบรนด์ไม่สำเร็จ (Could not load the brand settings.)"); },
    );
  }, []);
  useEffect(() => {
    load();
    return () => { latest.current++; };
  }, [load]);

  /** Swaps one row for a freshly saved or reloaded brand; every other row stays as it is. */
  const replaceRow = (brand: BrandConfig) =>
    setRows((current) => current && current.map((row) => (row.brand_id === brand.brand_id ? { brand_id: brand.brand_id, hostname: brand.hostnames[0]!, brand, error: null } : row)));

  // The base is the row's brand, so a 409 reload that replaces the row also moves the base without touching the draft.
  const editBrand = editing ? rows?.find((r) => r.brand_id === editing)?.brand ?? null : null;
  const dirty = editBrand !== null && draft !== null && isDirty(editBrand, draft);

  // Each open or close starts a new editor session; a save answer applies only to the session that sent it.
  const session = useRef(0);
  const savingNow = useRef(false);
  const mounted = useRef(false);
  // Unmounting ends the session, so an answer that arrives after it touches neither this screen's state nor the router guard.
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; session.current++; };
  }, []);
  const close = () => { session.current++; setEditing(null); setDraft(null); setBanner(null); };
  // The draft starts from the loaded brand each time a row opens; the editor then owns every edit to it.
  const openNow = (brand: BrandConfig) => { session.current++; setDraft(draftFromBrand(brand)); setBanner(null); setEditing(brand.brand_id); };

  // spec polish D8.2: ?brand=<id> (the ConfigPanel link) opens that brand's editor once, when the rows first load. An unknown id opens nothing.
  const deepLinkDone = useRef(false);
  useEffect(() => {
    if (!rows || deepLinkDone.current) return;
    deepLinkDone.current = true;
    const id = new URLSearchParams(window.location.search).get("brand");
    const brand = id ? rows.find((r) => r.brand_id === id)?.brand : null;
    if (brand) {
      openNow(brand);
      // The link is spent: a reload or a later load must not reopen the editor.
      navigate("/settings", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  /** Asks once. On discard the guard is cleared and the drawer closed here, because the router navigates on `true` even if the guard cleared itself. */
  const askDiscard = useCallback(async () => {
    // The drawer is locked while a save is in flight, so the page stays: a discard now would hide a save that core still applies.
    if (savingNow.current) return false;
    const ok = await confirm({
      title: "ทิ้งการแก้ไขที่ยังไม่บันทึก? (Discard unsaved changes?)",
      confirmLabel: "ทิ้งการแก้ไข (Discard)",
      tone: "danger",
    });
    if (ok && !savingNow.current) {
      session.current++;
      setLeaveGuard(null);
      setEditing(null);
      setDraft(null);
      setBanner(null);
    }
    return ok && !savingNow.current;
  }, [confirm]);

  const requestClose = () => { if (saving) return; if (dirty) void askDiscard(); else close(); };
  const open = (brand: BrandConfig) => {
    if (saving) return;
    if (!dirty) return openNow(brand);
    void askDiscard().then((ok) => { if (ok) openNow(brand); });
  };

  // Registered only while dirty; the cleanup also covers save, discard and unmount.
  useEffect(() => {
    if (!dirty) return;
    setLeaveGuard(askDiscard);
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      setLeaveGuard(null);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [dirty, askDiscard]);

  const review = async () => {
    if (!editBrand || !draft || saving) return;
    const base = editBrand;
    const mine = session.current;
    const patch = buildPatch(base, draft);
    if (!patch) return;
    const domain = base.hostnames[0] ?? base.brand_id;
    const money = touchesMoney(patch);
    const ok = await confirm({
      title: `บันทึกการเปลี่ยนแปลงของ ${domain}? (Save changes?)`,
      body: (
        <>
          <table className="settings-diff">
            <thead>
              <tr><th>ค่า (Setting)</th><th>ก่อน (Before)</th><th>หลัง (After)</th></tr>
            </thead>
            <tbody>
              {diffRows(base, patch).map((r) => <tr key={r.field}><td>{r.label}</td><td>{r.before}</td><td>{r.after}</td></tr>)}
            </tbody>
          </table>
          {redrawsVisitors(base, patch) && <p>ผู้เข้าชมเดิมจะถูกสุ่มแขนใหม่ (Returning visitors are drawn again)</p>}
          {money && <p>ค่านี้เปลี่ยนเส้นทางเงินของแบรนด์ทันที (This changes the brand's money routing at once)</p>}
        </>
      ),
      confirmLabel: "บันทึก (Save)",
      tone: money ? "danger" : "default",
    });
    if (!ok || mine !== session.current) return;
    savingNow.current = true;
    setSaving(true);
    setBanner(null);
    try {
      const res = await api.patchBrand(base.brand_id, { ...patch, expected_updated_at: base.updated_at });
      if (mine !== session.current) {
        // Defence only: no UI path reaches the still-mounted case, because the drawer is locked during a save.
        // Core holds this brand now, so a screen still mounted shows it in the table; nothing else of the old session is touched.
        if (mounted.current) replaceRow(res.brand);
        return;
      }
      replaceRow(res.brand);
      setLeaveGuard(null);
      close();
      setToast({ kind: "ok", text: res.changed.length ? "บันทึกแล้ว (Saved)" : "ไม่มีค่าที่เปลี่ยน (Nothing changed)" });
    } catch (e) {
      if (mine !== session.current) return;
      if (e instanceof ApiError && e.status === 409 && e.body?.error === "conflict") {
        setBanner({ kind: "conflict", text: CONFLICT_TEXT });
        try {
          const fresh = await api.brand(base.brand_id);
          if (mine !== session.current) return;
          replaceRow(fresh);
          // Untouched fields take the reloaded values, so the next save cannot revert the other editor's change.
          setDraft((d) => d && rebaseDraft(base, fresh, d));
        } catch (reloadError) {
          if (mine !== session.current) return;
          const why = reloadError instanceof ApiError ? reloadError.thai : "โหลดค่าล่าสุดไม่สำเร็จ (Could not load the latest values.)";
          setBanner({ kind: "conflict", text: `${CONFLICT_TEXT} ${why}` });
        }
      } else {
        setBanner({ kind: "error", text: e instanceof ApiError ? e.thai : "บันทึกไม่สำเร็จ (Could not save.)" });
      }
    } finally {
      savingNow.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const columns: Column<SettingsRow>[] = [
    { key: "brand", header: "แบรนด์ (Brand)", cell: (r) => <BrandLabel brandId={r.brand_id} domain={r.hostname} /> },
    {
      key: "status",
      header: "สถานะ (Status)",
      cell: (r) => r.brand
        ? <StatusBadge tone={statusBadgeTone[r.brand.status] ?? "mute"} label={statusLabel[r.brand.status] ?? r.brand.status} />
        : <StatusBadge tone="bad" label="โหลดไม่สำเร็จ (Could not load)" />,
    },
    { key: "aid", header: "AID", mono: true, cell: (r) => (r.brand ? formatSetting("aid", r.brand.aid) : NONE) },
    { key: "ab", header: "A/B", cell: (r) => (r.brand ? formatSetting("ab_config", r.brand.ab_config) : NONE) },
    { key: "flow", header: "เกต (Flow gate)", cell: (r) => (r.brand ? formatSetting("flow_gate_mode", r.brand.flow_gate_mode) : NONE) },
    { key: "buckets", header: "ช่วงยอดเงิน (Amount buckets)", cell: (r) => (r.brand ? formatSetting("amount_buckets", r.brand.amount_buckets) : NONE) },
    { key: "keyword", header: "คีย์เวิร์ด (Keyword default)", cell: (r) => (r.brand ? formatSetting("keyword_default", r.brand.keyword_default) : NONE) },
    { key: "prepop", header: SETTINGS_LABELS.prepop_base, mono: true, cell: (r) => (r.brand ? formatSetting("prepop_base", r.brand.prepop_base) : NONE) },
    { key: "drain", header: SETTINGS_LABELS.drain_key, mono: true, cell: (r) => (r.brand ? formatSetting("drain_key", r.brand.drain_key) : NONE) },
    { key: "updated", header: "แก้ไขล่าสุด (Updated)", cell: (r) => (r.brand ? <time dateTime={r.brand.updated_at}>{fmtTime(r.brand.updated_at)}</time> : NONE) },
    {
      key: "edit",
      header: "การทำงาน (Actions)",
      label: "",
      cell: (r) => r.brand
        ? <button type="button" className="btn" aria-label={`แก้ไข (Edit) ${r.hostname}`} onClick={() => open(r.brand!)}>แก้ไข (Edit)</button>
        : null,
    },
  ];

  return <div className="stack settings-page">
    <div className="head">
      <div>
        <h1 aria-label="ตั้งค่า (Settings)">ตั้งค่า</h1>
        <p className="sub">AID, A/B test, เกต, ช่วงยอดเงิน, คีย์เวิร์ด, Prepop base และ Drain key ของทุกแบรนด์</p>
      </div>
    </div>
    {error
      ? <div className="note neg settings-error" style={{ background: "var(--badbg)", color: "var(--bad)" }} role="alert">
        <p>{error}</p>
        <button type="button" className="btn" onClick={load}>ลองอีกครั้ง (Retry)</button>
      </div>
      : !rows ? <Spinner />
      : <section className="panel">
        <DataTable
          label="ตั้งค่าแบรนด์ (Brand settings)"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.brand_id}
          empty={<p className="hint">ยังไม่มีแบรนด์ (No brands yet)</p>}
        />
      </section>}
    {editBrand && draft && (
      <SettingsEditor brand={editBrand} draft={draft} onDraft={(d) => { if (!saving) setDraft(d); }} onReview={review} onClose={requestClose} banner={banner} saving={saving} />
    )}
    {confirmDialog}
    {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
  </div>;
}
