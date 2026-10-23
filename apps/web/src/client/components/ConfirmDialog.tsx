import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

export type ConfirmOptions = { title: string; body?: ReactNode; confirmLabel: string; tone?: "danger" | "default" };
type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };
const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Replaces window.confirm. Render the returned element; await the function. */
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  const close = useCallback((ok: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(ok);
    returnFocus.current?.focus?.();
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // The opener is whatever had focus before the first dialog; a replacing dialog must not capture its own Cancel button.
    if (!pendingRef.current) returnFocus.current = document.activeElement as HTMLElement | null;
    // One dialog at a time: a new question cancels the open one.
    pendingRef.current?.resolve(false);
    const next = { ...options, resolve };
    pendingRef.current = next;
    setPending(next);
  }), []);

  // An unmounted screen must not leave a promise waiting forever.
  useEffect(() => () => { pendingRef.current?.resolve(false); }, []);

  return [confirm, pending ? <Dialog key={pending.title} pending={pending} onClose={close} /> : null];
}

function Dialog({ pending, onClose }: { pending: Pending; onClose: (ok: boolean) => void }) {
  const titleId = useId();
  const bodyId = useId();
  // Focus starts inside the dialog (Cancel) and Tab wraps, so keys reach this handler. Escape stops here so a shell
  // Escape handler (drawer, user menu) does not also fire.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose(false);
      return;
    }
    if (e.key !== "Tab") return;
    const stops = e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE);
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="modal-wrap" onKeyDown={onKeyDown} onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}>
      <div className="card modal confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={pending.body ? bodyId : undefined}>
        <h2 id={titleId}>{pending.title}</h2>
        {pending.body && <div id={bodyId} className="confirm-body">{pending.body}</div>}
        <div className="confirm-actions">
          <button type="button" className="btn" autoFocus onClick={() => onClose(false)}>ยกเลิก (Cancel)</button>
          <button type="button" className={pending.tone === "danger" ? "btn danger" : "btn pri"} onClick={() => onClose(true)}>{pending.confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
