import type { TemplateCategory, TemplateReviewStatus, TemplateVersionSummary } from "@anjuna/contracts";
import { Archive, Trash2, X } from "lucide-react";
import { Chip, type ChipTone } from "../components/Chip";
import { TemplateCategoryPicker } from "./TemplateCategories";

export const statusLabel: Record<TemplateReviewStatus, string> = {
  checking: "กำลังตรวจ",
  rejected: "ไม่ผ่าน",
  awaiting_approval: "รออนุมัติ",
  approved: "ใช้ได้",
};
export const statusTone: Record<TemplateReviewStatus, ChipTone> = { checking: "info", rejected: "danger", awaiting_approval: "warning", approved: "success" };

/** Why the bulk bar refuses delete before it asks the server: a brand still uses one of the selected templates. */
export const deleteBlockReason = (items: TemplateVersionSummary[]): string | null =>
  items.some((t) => t.brands_using > 0) ? "มีเทมเพลตที่แบรนด์ใช้อยู่ ลบไม่ได้ ใช้เก็บถาวรแทน" : null;

/** Dark bar above the table while rows are checked. Owner only: the server refuses these writes for an employee. */
export function BulkBar({ items, categories, busy, onMove, onArchive, onDelete, onClear }: {
  items: TemplateVersionSummary[];
  categories: TemplateCategory[];
  busy: boolean;
  /** `null` clears the category. */
  onMove: (categoryId: string | null) => void;
  onArchive: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const reason = deleteBlockReason(items);
  const allArchived = items.every((t) => t.archived);
  return (
    <div className="tpl-bulk" role="toolbar" aria-label="จัดการเทมเพลตที่เลือก">
      <span className="tpl-bulk-count">เลือก {items.length} รายการ</span>
      <select aria-label="ย้ายไปหมวด" value="" disabled={busy} onChange={(e) => { if (e.target.value) onMove(e.target.value === "__none" ? null : e.target.value); }}>
        <option value="">ย้ายไปหมวด…</option>
        <option value="__none">ไม่มีหมวด</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" className="btn tpl-bulk-btn" disabled={busy || allArchived} onClick={onArchive}><Archive size={16} aria-hidden="true" />เก็บถาวร</button>
      <button type="button" className="btn tpl-bulk-btn" disabled={busy || reason !== null} title={reason ?? undefined} onClick={onDelete}><Trash2 size={16} aria-hidden="true" />ลบ</button>
      {reason && <span className="tpl-bulk-reason">{reason}</span>}
      <button type="button" className="tpl-bulk-clear" aria-label="ยกเลิกการเลือก" onClick={onClear}><X size={16} aria-hidden="true" /></button>
    </div>
  );
}

/** 64x48 preview. Without a screenshot a quiet block stands in. */
function Thumb({ t }: { t: TemplateVersionSummary }) {
  return t.thumbnail_url
    ? <img className="tpl-thumb" src={t.thumbnail_url} alt={`ตัวอย่าง ${t.name} (Template preview)`} loading="lazy" width={64} height={48} />
    : <span className="tpl-thumb tpl-thumb-empty" aria-hidden="true" />;
}

export function TemplateTable({ items, categories, owner, busy, checked, openId, hasDetail, onToggle, onToggleAll, onOpen, onCategory, onApprove }: {
  items: TemplateVersionSummary[];
  categories: TemplateCategory[];
  owner: boolean;
  busy: boolean;
  checked: ReadonlySet<string>;
  /** The version whose drawer is open. */
  openId: string | null;
  /** True while that version's detail is loaded in the drawer, so its row needs no approve button. */
  hasDetail: (versionId: string) => boolean;
  onToggle: (versionId: string) => void;
  onToggleAll: () => void;
  onOpen: (versionId: string) => void;
  onCategory: (t: TemplateVersionSummary, categoryId: string | null) => void;
  onApprove: (t: TemplateVersionSummary) => void;
}) {
  const allChecked = items.length > 0 && items.every((t) => checked.has(t.template_version_id));
  return (
    <div className="tpl-scroll">
      <table className="tpl-table">
        <thead>
          <tr>
            {owner && <th className="tpl-check"><input type="checkbox" aria-label="เลือกทั้งหมด" checked={allChecked} onChange={onToggleAll} /></th>}
            <th>เทมเพลต</th>
            <th>หมวด</th>
            <th>สถานะ</th>
            <th>เวอร์ชัน</th>
            <th className="num">แบรนด์ที่ใช้</th>
            <th><span className="sr-only">การทำงาน</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((t) => {
            const id = t.template_version_id;
            return (
              <tr key={id} className={id === openId ? "sel" : undefined} data-checked={checked.has(id) ? "true" : undefined}>
                {owner && <td className="tpl-check"><input type="checkbox" aria-label={`เลือก ${t.name} v${t.version}`} checked={checked.has(id)} onChange={() => onToggle(id)} /></td>}
                <td>
                  <div className="tpl-name-cell">
                    <Thumb t={t} />
                    <div>
                      <button type="button" className="tpl-open" aria-pressed={id === openId} onClick={() => onOpen(id)}><b>{t.name}</b></button>
                      <small><code>{t.template_id}</code> · ส่งโดย {t.submitted_by_label ?? "-"} · {t.created_at.slice(0, 10)}</small>
                    </div>
                  </div>
                </td>
                <td><TemplateCategoryPicker templateName={t.name} value={t.category_id} categories={categories} owner={owner} busy={busy} onChange={(categoryId) => onCategory(t, categoryId)} /></td>
                <td>
                  <span className="tpl-status">
                    <Chip tone={statusTone[t.status]} dot>{statusLabel[t.status]}</Chip>
                    {t.archived && <Chip tone="neutral">เก็บถาวร</Chip>}
                  </span>
                </td>
                <td className="num">v{t.version}</td>
                <td className="num">{t.brands_using}</td>
                <td className="tpl-action">
                  {owner && t.status === "awaiting_approval" && !hasDetail(id)
                    ? <button type="button" className="btn pri" aria-label={`อนุมัติ ${t.name} v${t.version}`} disabled={busy} onClick={() => onApprove(t)}>อนุมัติ</button>
                    : <button type="button" className="btn" aria-label={`ดูรายละเอียด ${t.name} v${t.version}`} onClick={() => onOpen(id)}>ดูรายละเอียด</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
