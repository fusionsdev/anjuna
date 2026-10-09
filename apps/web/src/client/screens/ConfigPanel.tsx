import { BRAND_PATCH_FIELD_GROUPS, roleAtLeast, type BrandConfig, type BrandPatchRequest, type FlowGateMode } from "@anjuna/contracts";
import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Me } from "../api";

/** The UI hides what the role cannot do; the server enforces it regardless. */
const can = (me: Me, group: keyof typeof BRAND_PATCH_FIELD_GROUPS) => roleAtLeast(me.role, BRAND_PATCH_FIELD_GROUPS[group].min_role);

export function ConfigPanel({ me, brandId, onClose, onChanged }: { me: Me; brandId: string; onClose: () => void; onChanged: () => void }) {
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [issuedToken, setIssuedToken] = useState<string | null>(null);

  const load = useCallback(() => api.brand(brandId).then(setBrand, (e) => setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "โหลดไม่สำเร็จ" })), [brandId]);
  useEffect(() => void load(), [load]);

  /** Runs one request, reloads the brand and the list, and reports the outcome. */
  async function act<T>(fn: () => Promise<T>, okText: string): Promise<T | undefined> {
    setToast(null);
    try {
      const r = await fn();
      setToast({ kind: "ok", text: okText });
      await load();
      onChanged();
      return r;
    } catch (e) {
      setToast({ kind: "err", text: e instanceof ApiError ? e.thai : "ไม่สำเร็จ" });
      if (e instanceof ApiError && e.status === 409) await load();
      return undefined;
    }
  }

  const save = (body: BrandPatchRequest, okText = "บันทึกแล้ว") =>
    act(() => api.patchBrand(brandId, { ...body, expected_updated_at: brand?.updated_at }), okText);

  if (!brand) return <Drawer onClose={onClose} title={brandId}>{toast ? <div className="error">{toast.text}</div> : <div className="muted">กำลังโหลด…</div>}</Drawer>;

  return (
    <Drawer onClose={onClose} title={brand.hostnames[0]!}>
      {toast && <div className={toast.kind === "ok" ? "ok" : "error"} role="status">{toast.text}</div>}
      <p className="muted small">
        บัญชี {brand.account} · <span className={`pill ${brand.status}`}>{brand.status}</span> · form <code>{brand.form_version ?? "—"}</code>
      </p>

      <Section title="สถานะ (Pause / Resume)">
        {(brand.status !== "live" || me.role === "owner") && <button
          className={brand.status === "live" ? "danger" : "primary"}
          onClick={() => act(() => api.setStatus(brandId, brand.status === "live" ? "pause" : "resume"), brand.status === "live" ? "หยุดแบรนด์แล้ว" : "เปิดแบรนด์แล้ว")}
        >
          {brand.status === "live" ? "Pause แบรนด์" : "Resume แบรนด์"}
        </button>}
      </Section>

      <KeywordSection key={brand.updated_at} brand={brand} onSave={(k) => save({ keyword_default: k })} />

      {me.role === "owner" && <Section title="Rollback">
        <button
          onClick={() => void act(() => api.rollback(brandId), "")}
          title="coming with T10"
        >
          Rollback เป็นเวอร์ชันก่อนหน้า <span className="badge">coming with T10</span>
        </button>
        <p className="muted small">ยังเป็น placeholder: ปุ่มนี้จะทำงานจริงเมื่อ factory Workflows (T10) พร้อม</p>
      </Section>}

      {can(me, "ab_weights") && <AbSection key={`ab${brand.updated_at}`} brand={brand} onSave={(ab) => save({ ab_config: ab })} />}
      {can(me, "amount_buckets") && <BucketsSection key={`b${brand.updated_at}`} brand={brand} onSave={(b) => save({ amount_buckets: b })} />}
      {can(me, "flow_gate_mode") && (
        <Section title="Flow gate">
          <select value={brand.flow_gate_mode} onChange={(e) => save({ flow_gate_mode: e.target.value as FlowGateMode })}>
            <option value="param">param</option>
            <option value="signed_cookie">signed_cookie</option>
          </select>
        </Section>
      )}
      {can(me, "money_routing") && (
        <MoneySection
          key={`m${brand.updated_at}`}
          brand={brand}
          onSave={(m) => save(m)}
          onRotate={async () => {
            if (!window.confirm("หมุน (rotate) postback token? ต้องอัปเดต URL ใน LeadsGate ทันที")) return;
            const r = await act(() => api.patchBrand(brandId, { rotate_postback_token: true, expected_updated_at: brand.updated_at }), "หมุน token แล้ว");
            if (r?.issued_postback_token) setIssuedToken(r.issued_postback_token);
          }}
        />
      )}

      {issuedToken && <TokenModal token={issuedToken} onClose={() => setIssuedToken(null)} />}
    </Drawer>
  );
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="drawer-wrap">
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" aria-label="Brand config">
        <header>
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>ปิด</button>
        </header>
        {children}
      </aside>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function KeywordSection({ brand, onSave }: { brand: BrandConfig; onSave: (k: string | null) => void }) {
  const [v, setV] = useState(brand.keyword_default ?? "");
  return (
    <Section title="Keyword default">
      <div className="row">
        <input value={v} maxLength={60} onChange={(e) => setV(e.target.value)} placeholder="ว่าง = ใช้ข้อความเริ่มต้นของ template" />
        <button className="primary" onClick={() => onSave(v.trim() === "" ? null : v.trim())}>บันทึก</button>
      </div>
    </Section>
  );
}

function AbSection({ brand, onSave }: { brand: BrandConfig; onSave: (ab: BrandConfig["ab_config"]) => void }) {
  const ab = brand.ab_config;
  const [weights, setWeights] = useState<number[]>(ab?.variants.map((v) => v.weight) ?? []);
  if (!ab) return <Section title="A/B weights"><p className="muted">ไม่มี A/B test ที่รันอยู่</p></Section>;
  const sum = weights.reduce((s, w) => s + w, 0);
  const two = ab.variants.length === 2;
  return (
    <Section title="A/B weights (รวมต้องเป็น 100%)">
      {two ? (
        <>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={weights[0]}
            aria-label="A/B weight"
            onChange={(e) => setWeights([Number(e.target.value), 100 - Number(e.target.value)])}
          />
          <div className="row split">
            {ab.variants.map((v, i) => (
              <span key={v.id}>{v.id}: <b>{weights[i]}%</b></span>
            ))}
          </div>
        </>
      ) : (
        ab.variants.map((v, i) => (
          <label key={v.id} className="row">
            {v.id}
            <input type="number" min={0} max={100} step={1} value={weights[i]} onChange={(e) => setWeights(weights.map((w, j) => (j === i ? Math.trunc(Number(e.target.value)) : w)))} />
          </label>
        ))
      )}
      <div className={sum === 100 ? "muted small" : "error"}>รวม {sum}%</div>
      <button className="primary" disabled={sum !== 100} onClick={() => onSave({ ...ab, variants: ab.variants.map((v, i) => ({ id: v.id, weight: weights[i]! })) })}>
        บันทึก A/B
      </button>
    </Section>
  );
}

function BucketsSection({ brand, onSave }: { brand: BrandConfig; onSave: (b: number[]) => void }) {
  const [text, setText] = useState(brand.amount_buckets.join(", "));
  const parsed = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  const valid = parsed.length > 0 && parsed.every((n, i) => Number.isInteger(n) && n > 0 && (i === 0 || n > parsed[i - 1]!));
  return (
    <Section title="Amount buckets">
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Amount buckets" />
        <button className="primary" disabled={!valid} onClick={() => onSave(parsed)}>บันทึก</button>
      </div>
      {!valid && <div className="error small">ใส่ตัวเลขจำนวนเต็ม เรียงจากน้อยไปมาก คั่นด้วยจุลภาค</div>}
    </Section>
  );
}

function MoneySection({ brand, onSave, onRotate }: { brand: BrandConfig; onSave: (m: BrandPatchRequest) => void; onRotate: () => void }) {
  const [aid, setAid] = useState(brand.aid);
  const [prepop, setPrepop] = useState(brand.prepop_base);
  const [drain, setDrain] = useState(brand.drain_key);
  return (
    <Section title="Money-path (เฉพาะ Owner)">
      <label>LeadsGate aid<input value={aid} onChange={(e) => setAid(e.target.value)} /></label>
      <label>Prepop base<input value={prepop} onChange={(e) => setPrepop(e.target.value)} /></label>
      <label>Drain key<input value={drain} onChange={(e) => setDrain(e.target.value)} /></label>
      <button
        className="primary"
        onClick={() =>
          onSave({
            ...(aid !== brand.aid && { aid }),
            ...(prepop !== brand.prepop_base && { prepop_base: prepop }),
            ...(drain !== brand.drain_key && { drain_key: drain }),
          })
        }
      >
        บันทึก
      </button>
      <div className="row split">
        <span>Postback token: <b>{brand.postback_token === "set" ? "ตั้งค่าแล้ว" : "ยังไม่ได้ตั้งค่า"}</b></span>
        <button className="danger" onClick={onRotate}>Rotate token</button>
      </div>
    </Section>
  );
}

function TokenModal({ token, onClose }: { token: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="modal-wrap" role="dialog" aria-modal="true" aria-label="Postback token ใหม่">
      <div className="card modal">
        <h2>Postback token ใหม่</h2>
        <div className="warn">คุณจะไม่เห็น token นี้อีก (you will not see this again) — คัดลอกแล้วนำไปใส่ใน LeadsGate postback URL ทันที</div>
        <code className="token">{token}</code>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              await navigator.clipboard?.writeText(token).catch(() => undefined);
              setCopied(true);
            }}
          >
            {copied ? "คัดลอกแล้ว" : "คัดลอก"}
          </button>
          <button onClick={onClose}>ปิด</button>
        </div>
      </div>
    </div>
  );
}
