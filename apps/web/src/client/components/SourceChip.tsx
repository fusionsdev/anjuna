import { Database } from "lucide-react";
import type { ReactNode } from "react";

/** Names where the numbers of a card come from, for example "D1 · brands". */
export function SourceChip({ children }: { children: ReactNode }) {
  return (
    <span className="source-chip">
      <Database size={12} aria-hidden="true" />
      {children}
    </span>
  );
}
