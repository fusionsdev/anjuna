// spec polish
import type { AuditEntry } from "@anjuna/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, type Me, type PanelUser } from "../api";
import { BrandLabel, useBrandDomains } from "../brand-labels";
import { DataTable, type Column } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { LoadMore } from "../components/LoadMore";
import { Spinner } from "../components/Spinner";

const fmt = (iso: string) => new Date(iso).toLocaleString("th-TH", { hour12: false });
const short = (v: Record<string, unknown> | null) => (v ? Object.entries(v).map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(", ") : "—");
const diff = (v: Record<string, unknown> | null) => <span className="hint" style={{ display: "block", minWidth: 180, overflowWrap: "anywhere" }}>{short(v)}</span>;

const TARGET_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "brand", label: "แบรนด์ (brand)" },
  { value: "user", label: "ผู้ใช้ (user)" },
  { value: "template", label: "เทมเพลต (template)" },
  { value: "suppression", label: "รายการบล็อก (suppression)" },
];

function actorCell(entry: AuditEntry, usersById: Map<string, PanelUser>, me: Me) {
  if (entry.actor_role === "system") return <span>ระบบ (system)</span>;
  const user = usersById.get(entry.actor_id);
  if (user) return <span style={{ overflowWrap: "anywhere" }}>{user.name} ({user.email})</span>;
  if (entry.actor_id === me.id) return <span style={{ overflowWrap: "anywhere" }}>{me.email}</span>;
  return <code title="ผู้ใช้ที่ถูกลบ (Deleted user)" style={{ fontSize: "0.85em", overflowWrap: "anywhere" }}>{entry.actor_id}</code>;
}

export function AuditScreen({ me }: { me: Me }) {
  const owner = me.role === "owner";
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [users, setUsers] = useState<PanelUser[]>([]);
  const [actorId, setActorId] = useState("");
  const [targetType, setTargetType] = useState("");
  const [targetId, setTargetId] = useState("");
  const domains = useBrandDomains();
  const labelOf = (brandId: string) => domains.get(brandId) ?? brandId;
  // Bumped on every first-page load, so a Load more answer for old filters is dropped.
  const generation = useRef(0);

  // Owner loads the user list once, for names and the actor select. An employee never calls it.
  useEffect(() => {
    if (!owner) return;
    let active = true;
    api.users().then(
      (list) => { if (active) setUsers(list); },
      () => { if (active) setUsers([]); },
    );
    return () => { active = false; };
  }, [owner]);

  const query: { actor_id?: string; target_type?: string; target_id?: string } = {};
  if (owner && actorId) query.actor_id = actorId;
  if (owner && targetType) query.target_type = targetType;
  if (owner && targetId) query.target_id = targetId;

  useEffect(() => {
    const mine = ++generation.current;
    setLoadingMore(false);
    api.audit(query).then(
      (r) => {
        if (generation.current !== mine) return;
        setEntries(r.entries);
        setNextCursor(r.next_cursor);
        setError(null);
      },
      (e: unknown) => {
        if (generation.current !== mine) return;
        setError(e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ");
      },
    );
    return () => { generation.current += 1; };
  }, [actorId, targetType, targetId, owner]);

  const loadMore = () => {
    if (!nextCursor || loadingMore) return;
    const mine = generation.current;
    const cursor = nextCursor;
    setLoadingMore(true);
    api.audit({ ...query, cursor }).then(
      (page) => {
        if (generation.current !== mine) return;
        setEntries((prev) => (prev ? [...prev, ...page.entries] : page.entries));
        setNextCursor(page.next_cursor);
        setLoadingMore(false);
      },
      () => { if (generation.current === mine) setLoadingMore(false); },
    );
  };

  const usersById = new Map(users.map((u) => [u.id, u]));
  const brandOptions = [...domains].sort((a, b) => a[1].localeCompare(b[1]));

  const columns: Column<AuditEntry>[] = [
    { key: "at", header: "เวลา", cell: (e) => fmt(e.at) },
    { key: "actor", header: "ผู้ใช้", cell: (e) => actorCell(e, usersById, me) },
    {
      key: "role",
      header: "สิทธิ์",
      cell: (e) => <span className={`pill ${e.actor_role === "owner" ? "p-blue" : "p-mute"}`}>{e.actor_role === "owner" ? "Owner" : e.actor_role === "employee" ? "พนักงาน" : e.actor_role}</span>,
    },
    { key: "action", header: "สิ่งที่ทำ", cell: (e) => e.action, mono: true },
    { key: "target", header: "เป้าหมาย", cell: (e) => e.target.type === "brand" ? <BrandLabel brandId={e.target.id} domain={labelOf(e.target.id)} /> : `${e.target.type}:${e.target.id}` },
    { key: "old", header: "เดิม", cell: (e) => diff(e.old) },
    { key: "new", header: "ใหม่", cell: (e) => diff(e.new) },
  ];

  return (
    <>
      <h1 aria-label="ประวัติการเปลี่ยนแปลง (Audit log)">ประวัติการแก้ไข</h1>
      <p className="hint">ทุกการเปลี่ยนแปลงในระบบ ใครทำ ทำอะไร เมื่อไหร่</p>
      <p className="hint">{owner ? "แสดงทุกรายการ" : "แสดงเฉพาะรายการของคุณ"}</p>
      {owner && (
        <section className="panel" aria-label="ตัวกรองประวัติการแก้ไข (Audit filters)" style={{ marginTop: 16 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label>ผู้ใช้ (Actor)
              <select value={actorId} onChange={(e) => setActorId(e.target.value)}>
                <option value="">ทั้งหมด (All)</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                <option value="system">ระบบ (system)</option>
              </select>
            </label>
            <label>ประเภทเป้าหมาย (Target type)
              <select value={targetType} onChange={(e) => { setTargetType(e.target.value); setTargetId(""); }}>
                <option value="">ทั้งหมด (All)</option>
                {TARGET_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
            {targetType === "brand" ? (
              <label>แบรนด์ (Brand)
                <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                  <option value="">ทั้งหมด (All)</option>
                  {brandOptions.map(([id, domain]) => <option key={id} value={id}>{domain}</option>)}
                </select>
              </label>
            ) : (
              <label>รหัสเป้าหมาย (Target ID)
                <input type="text" value={targetId} onChange={(e) => setTargetId(e.target.value)} />
              </label>
            )}
          </div>
        </section>
      )}
      {error && <div className="note neg" style={{ background: "var(--badbg)", color: "var(--bad)" }}>{error}</div>}
      {!entries && !error && <Spinner />}
      {entries && (
        <section className="panel" style={{ marginTop: 16 }}>
          <DataTable label="ประวัติการแก้ไข" columns={columns} rows={entries} rowKey={(e) => String(e.id)} empty={<EmptyState title="ยังไม่มีรายการ" />} />
          <LoadMore shown={entries.length} hasMore={nextCursor !== null} atMax={false} loading={loadingMore} onMore={loadMore} narrowHint="กรุณากรองให้แคบลง (Narrow the filters)" />
        </section>
      )}
    </>
  );
}
