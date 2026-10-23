import { useEffect, useRef } from "react";

export function Toast({ kind, text, onDismiss, timeoutMs = 5000 }: { kind: "ok" | "err"; text: string; onDismiss: () => void; timeoutMs?: number }) {
  // The timer reads the latest callback, so a parent's inline onDismiss does not restart the countdown.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss.current(), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [text, timeoutMs]);
  return (
    <div className={`toast toast-${kind}`} role={kind === "err" ? "alert" : "status"}>
      <span>{text}</span>
      <button type="button" className="link" aria-label="ปิด (Close)" onClick={onDismiss}>×</button>
    </div>
  );
}
