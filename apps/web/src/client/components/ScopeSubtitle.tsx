import type { ReactNode } from "react";
import { scopeSummary } from "../brand-scope";
import { useBrandScope } from "../useBrandScope";
import { Chip } from "./Chip";

/** The line under a page title: the page's own text, the scope chip and an "แก้ไข" button that opens the scope popover. */
export function ScopeSubtitle({ children }: { children?: ReactNode }) {
  const { visibleCount, totalCount, setOpen, saveFailed } = useBrandScope();
  return (
    <span className="scope-subtitle">
      {children}
      {visibleCount !== null && totalCount !== null && <Chip tone="neutral">{scopeSummary(visibleCount, totalCount)}</Chip>}
      {saveFailed && <span role="status"><Chip tone="warning">บันทึกขอบเขตไม่สำเร็จ ใช้ได้เฉพาะเครื่องนี้</Chip></span>}
      <button type="button" className="edit" onClick={() => setOpen(true)}>แก้ไข</button>
    </span>
  );
}
