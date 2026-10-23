import type { ReactNode } from "react";

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return <div className="empty-state"><p className="empty-title">{title}</p>{hint && <p className="hint">{hint}</p>}{action}</div>;
}
