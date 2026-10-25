import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type PanelUser, type UserSession } from "../api";
import { EmptyState } from "../components/EmptyState";
import { Spinner } from "../components/Spinner";
import { Toast } from "../components/Toast";

const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });

// spec polish D1.2: the sessions drawer. Drawer markup copies ConfigPanel's Drawer.
export function UserSessionsDrawer({ user, onClose }: { user: PanelUser; onClose: () => void }) {
  const [sessions, setSessions] = useState<UserSession[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    return api.userSessions(user.id).then(
      (r) => setSessions(r.sessions),
      (e) => {
        const text = e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ";
        setLoadError(text);
        setToast({ kind: "err", text });
      },
    );
  }, [user.id]);
  useEffect(() => void load(), [load]);

  async function revoke(fn: () => Promise<unknown>, okText: string) {
    setToast(null);
    try {
      await fn();
      setToast({ kind: "ok", text: okText });
      await load();
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ" });
    }
  }

  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label={`เซสชันของ ${user.email} (Sessions of ${user.email})`}>
        <header>
          <h2>เซสชันของ {user.email} (Sessions)</h2>
          <button className="link" onClick={onClose}>ปิด (Close)</button>
        </header>
        {toast && <Toast kind={toast.kind} text={toast.text} onDismiss={() => setToast(null)} />}
        {loadError ? <p role="alert">{loadError}</p> : !sessions ? <Spinner /> : sessions.length === 0 ? <EmptyState title="ไม่มีเซสชัน (No sessions)" /> : (
          <>
            <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
              {sessions.map((s) => (
                <li key={s.id} className="panel" style={{ padding: 8 }}>
                  <code>{s.id}</code>
                  <div className="muted small">สร้างเมื่อ (Created) {fmt(s.created_at)} · หมดอายุ (Expires) {fmt(s.expires_at)}</div>
                  <div className="muted small">IP {s.ip_address ?? "—"} · {s.user_agent ?? "—"}</div>
                  <button className="btn" onClick={() => revoke(() => api.revokeUserSession(user.id, s.id), "เพิกถอนแล้ว (Revoked)")}>
                    เพิกถอน (Revoke)
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn danger" onClick={() => revoke(() => api.revokeUserSessions(user.id), "เพิกถอนทั้งหมดแล้ว (All revoked)")}>
              เพิกถอนทั้งหมด (Revoke all)
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
