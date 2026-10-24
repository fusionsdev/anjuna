// spec settings: the Owner-only table of every brand's money-routing and A/B settings.
import type { BrandConfig } from "@anjuna/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { BrandLabel } from "../brand-labels";
import { DataTable, type Column } from "../components/DataTable";
import { Spinner } from "../components/Spinner";
import { StatusBadge } from "../components/StatusBadge";
import { statusBadgeTone, statusLabel } from "../labels";
import { SETTINGS_LABELS, draftFromBrand, formatSetting, type SettingsDraft } from "../settings-draft";
import { SettingsEditor } from "./SettingsEditor";
import type { SettingsRow } from "../../shared/settings";
import "./Settings.css";

const fmtTime = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

const NONE = "—";

export function SettingsScreen(_props: { me: Me }) {
  const [rows, setRows] = useState<SettingsRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The brand id whose row drawer is open.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);

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
  void replaceRow;

  const editBrand = editing ? rows?.find((r) => r.brand_id === editing)?.brand ?? null : null;
  // The draft starts from the loaded brand each time a row opens; the editor then owns every edit to it.
  const open = (brand: BrandConfig) => { setDraft(draftFromBrand(brand)); setEditing(brand.brand_id); };
  const close = () => setEditing(null);

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
      ? <div className="note neg settings-error" role="alert">
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
      <SettingsEditor brand={editBrand} draft={draft} onDraft={setDraft} onReview={() => {}} onClose={close} banner={null} saving={false} />
    )}
  </div>;
}
