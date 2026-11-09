import type { ReactNode } from "react";

export type ChipTone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

/** A status pill in one of six tones. It replaces the old `.pill` classes one screen at a time. */
export function Chip({ tone = "neutral", dot = false, className = "", title, children }: { tone?: ChipTone; dot?: boolean; className?: string; title?: string; children: ReactNode }) {
  return (
    <span className={`chip chip-${tone}${className ? ` ${className}` : ""}`} data-tone={tone} title={title}>
      {dot && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}
