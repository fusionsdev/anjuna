import { useEffect } from "react";

export function Toast({ kind, text, onDismiss, timeoutMs = 5000 }: { kind: "ok" | "err"; text: string; onDismiss: () => void; timeoutMs?: number }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [text, timeoutMs, onDismiss]);
  return (
    <div className={`toast toast-${kind}`} role={kind === "err" ? "alert" : "status"}>
      <span>{text}</span>
      <button type="button" className="link" aria-label="ปิด (Close)" onClick={onDismiss}>×</button>
    </div>
  );
}
