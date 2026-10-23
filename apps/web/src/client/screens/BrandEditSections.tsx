/** The sections of the brand edit page (ConfigPanel) that have their own data: template version, logo and favicon. */
import { BRAND_ASSET_MAX_BYTES, brandInitialSvg, type BrandAssetKind, type BrandAssetSummary, type SealedTemplateVersion } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { useConfirm } from "../components/ConfirmDialog";

const label = (t: Pick<SealedTemplateVersion, "name" | "version">) => `${t.name} v${t.version}`;

/**
 * Owner action: move a live brand to another sealed template version. The server makes a new revision (the profile and site
 * text carry over, the template's own text defaults replace the old ones) and starts the existing redeploy install, which
 * rolls back to the current version when a step fails.
 */
export function TemplateVersionSection({ currentId, onChange }: { currentId: string | null; onChange: (target: SealedTemplateVersion) => Promise<boolean> }) {
  const [templates, setTemplates] = useState<SealedTemplateVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void api.sealedTemplates().then((r) => setTemplates(r.templates), () => setFailed(true)); }, []);
  const current = templates?.find((t) => t.template_version_id === currentId);
  const options = (templates ?? []).filter((t) => t.template_version_id !== currentId);
  const target = options.find((t) => t.template_version_id === chosen);
  return (
    <section className="section">
      <h3>เวอร์ชันเทมเพลต (Template version, Owner เท่านั้น)</h3>
      <p>ใช้อยู่ (Running): <b>{current ? label(current) : currentId ?? "—"}</b></p>
      {failed && <div className="error small" role="alert">โหลดรายการเทมเพลตไม่สำเร็จ (The template list did not load)</div>}
      {templates && options.length === 0 && <p className="muted small">ไม่มีเทมเพลตที่อนุมัติแล้วอีก (No other approved template)</p>}
      {options.length > 0 && (
        <div className="row">
          <select aria-label="เทมเพลตใหม่ (New template version)" value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">เลือกเทมเพลต… (Choose a template)</option>
            {options.map((t) => <option key={t.template_version_id} value={t.template_version_id}>{label(t)}</option>)}
          </select>
          <button className="btn danger" disabled={!target || busy} onClick={async () => {
            if (!target) return;
            setBusy(true);
            try { if (await onChange(target)) setChosen(""); } finally { setBusy(false); }
          }}>เปลี่ยนเทมเพลตและติดตั้งใหม่ (Change template and redeploy)</button>
        </div>
      )}
      <p className="muted small">ข้อความและโปรไฟล์ของแบรนด์ยังอยู่ ถ้าขั้นตอนใดล้มเหลวจะย้อนกลับเวอร์ชันเดิม (Profile and site text stay. A failed step rolls back to the current version.)</p>
    </section>
  );
}

const ASSETS: Array<{ kind: BrandAssetKind; title: string; hint: string }> = [
  { kind: "favicon", title: "ไอคอนแท็บ (Favicon)", hint: "/favicon.ico" },
  { kind: "logo", title: "โลโก้ (Logo)", hint: "/brand/logo" },
];
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const fallbackIcon = (name: string) => `data:image/svg+xml;utf8,${encodeURIComponent(brandInitialSvg(name))}`;

/**
 * Favicon and logo of the brand. The server scans the bytes like a template (platform names, other brands' names and domains)
 * and refuses SVG with script or outside references. Without a file the brand serves the first letter of its name.
 */
export function BrandAssetsSection({ brandId, brandName }: { brandId: string; brandName: string }) {
  const [assets, setAssets] = useState<BrandAssetSummary[] | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState<BrandAssetKind | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const load = useCallback(() => api.brandAssets(brandId).then((r) => setAssets(r.assets), () => setMessage({ kind: "err", text: "โหลดไฟล์ไม่สำเร็จ (The files did not load)" })), [brandId]);
  useEffect(() => void load(), [load]);

  async function run(kind: BrandAssetKind, task: () => Promise<unknown>, okText: string) {
    setBusy(kind);
    setMessage(null);
    try {
      await task();
      setMessage({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ (Failed)" });
    } finally {
      setBusy(null);
    }
  }

  async function remove(kind: BrandAssetKind, title: string) {
    const ok = await confirm({
      title: `ลบ${title}?`,
      body: "Remove it. The brand serves the generated letter icon again.",
      confirmLabel: "ลบ (Remove)",
      tone: "danger",
    });
    if (ok) await run(kind, () => api.deleteBrandAsset(brandId, kind), `${title}: ลบแล้ว (Removed)`);
  }

  return (
    <section className="section">
      <h3>โลโก้และไอคอน (Logo and favicon)</h3>
      {message && <div className={message.kind === "ok" ? "ok small" : "error small"} role="status">{message.text}</div>}
      {ASSETS.map(({ kind, title, hint }) => {
        const stored = assets?.find((a) => a.kind === kind);
        return (
          <div key={kind} className="asset-row">
            <div className="row split"><b>{title}</b><code className="muted small">{hint}</code></div>
            <div className="row">
              <img className="asset-preview" alt={`ตัวอย่าง ${title}`} src={stored ? `/api/brands/${encodeURIComponent(brandId)}/assets/${kind}?v=${stored.sha256}` : fallbackIcon(brandName)} />
              <span className="muted small">
                {stored ? `${stored.content_type} · ${kb(stored.byte_length)} · ${stored.updated_at.slice(0, 10)}` : "ยังไม่อัปโหลด: ใช้ตัวอักษรแรกของชื่อแบรนด์ (Not uploaded: the first letter of the brand name)"}
              </span>
            </div>
            <div className="row">
              <input type="file" aria-label={`ไฟล์ ${title} (${kind} file)`} accept="image/png,image/svg+xml,image/x-icon,.png,.svg,.ico" disabled={busy !== null}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (file.size > BRAND_ASSET_MAX_BYTES[kind]) return setMessage({ kind: "err", text: `${title}: ไฟล์ใหญ่เกิน ${kb(BRAND_ASSET_MAX_BYTES[kind])} (The file is over ${kb(BRAND_ASSET_MAX_BYTES[kind])})` });
                  void run(kind, () => api.uploadBrandAsset(brandId, kind, file), `${title}: อัปโหลดแล้ว มีผลภายในประมาณ 1 นาที (Uploaded, live within about a minute)`);
                }} />
              {stored && <button className="link" disabled={busy !== null} onClick={() => void remove(kind, title)}>ลบ (Remove) {title}</button>}
            </div>
            <p className="muted small">PNG, SVG หรือ ICO ไม่เกิน {kb(BRAND_ASSET_MAX_BYTES[kind])} (PNG, SVG or ICO, up to {kb(BRAND_ASSET_MAX_BYTES[kind])})</p>
          </div>
        );
      })}
      {confirmDialog}
    </section>
  );
}
