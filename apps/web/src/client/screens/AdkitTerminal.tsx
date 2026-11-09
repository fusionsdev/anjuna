import {
  TERMINAL_POLL_MAX_MS,
  TERMINAL_POLL_MS,
  roleAtLeast,
  type TerminalJobView,
  type TerminalMode,
} from "@anjuna/contracts";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Me } from "../api";
import { useConfirm } from "../components/ConfirmDialog";
import { StatusBadge, type Tone } from "../components/StatusBadge";
import { PANEL_ROLE_TABLE } from "../../server/panel-roles";
import "./AdkitTerminal.css";

const MODES: Array<{ id: TerminalMode; label: string; hint: string }> = [
  { id: "read", label: "อ่านอย่างเดียว", hint: "accounts, conversions, campaigns, results (list)" },
  { id: "draft", label: "ร่าง", hint: "campaigns create ไม่ใส่ --publish AdKit เก็บเป็นร่าง" },
  { id: "publish", label: "เผยแพร่", hint: "conversions create และหยุดแคมเปญ ต้องยืนยันก่อนส่ง" },
];

const EXAMPLES: Record<TerminalMode, string[]> = {
  read: ["manage google accounts list", "manage google campaigns list --account 1234567890", "manage google results campaigns --account 1234567890 --from 2026-11-01 --to 2026-11-02"],
  draft: [`manage google campaigns create --account 1234567890 --data '{"campaigns":[{"name":"brand-search-1","type":"SEARCH","dailyBudget":100}]}'`],
  publish: [`manage google campaigns update --account 1234567890 --campaign 123456 --data '{"status":"PAUSED"}' --publish`],
};

const STATUS: Record<TerminalJobView["status"], { label: string; tone: Tone }> = {
  queued: { label: "รอ VPS รับงาน", tone: "warn" },
  claimed: { label: "VPS กำลังรัน", tone: "blue" },
  done: { label: "เสร็จแล้ว", tone: "live" },
  failed: { label: "ไม่สำเร็จ", tone: "bad" },
  held: { label: "รอตรวจ", tone: "warn" },
  unknown: { label: "ไม่ทราบผล", tone: "warn" },
};
const FINAL: ReadonlySet<TerminalJobView["status"]> = new Set(["done", "failed", "unknown"]);

/** The first Thai issue core or the panel gave, else the shared message. */
function thaiError(e: unknown): string {
  if (!(e instanceof ApiError)) return "ไม่สำเร็จ ลองใหม่อีกครั้ง";
  if (e.body?.error === "invalid") return e.body.issues?.[0]?.message ?? e.thai;
  if (e.status === 403) return "สำหรับ Owner เท่านั้น";
  return e.thai;
}

type PollState = "polling" | "settled" | "timeout";

/** One run: shows the job and polls it every 3 seconds until it finishes or 2 minutes pass. */
function ResultView({ first }: { first: TerminalJobView }) {
  const [job, setJob] = useState(first);
  const [state, setState] = useState<PollState>(FINAL.has(first.status) ? "settled" : "polling");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== "polling") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const tick = async () => {
      if (stopped) return;
      if (Date.now() - started >= TERMINAL_POLL_MAX_MS) {
        setState("timeout");
        return;
      }
      try {
        const next = await api.adkitTerminalJob(first.id);
        if (stopped) return;
        setJob(next);
        setError(null);
        if (FINAL.has(next.status)) {
          setState("settled");
          return;
        }
      } catch (e) {
        if (stopped) return;
        setError(thaiError(e));
      }
      timer = setTimeout(() => void tick(), TERMINAL_POLL_MS);
    };
    timer = setTimeout(() => void tick(), TERMINAL_POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [first.id, state, attempt]);

  const s = STATUS[job.status];
  return (
    <section className="term-card term-result" aria-label="ผลคำสั่ง" aria-live="polite">
      <div className="term-result-head">
        <code className="term-line">{job.line}</code>
        <StatusBadge tone={s.tone} label={s.label} />
      </div>
      {error && <p className="term-reason" role="alert">{error}</p>}
      {state === "polling" && <p className="term-muted">ตรวจผลทุก 3 วินาที นานสุด 2 นาที</p>}
      {state === "timeout" && (
        <p className="term-muted" role="status">
          รอเกิน 2 นาทีแล้ว หยุดตรวจอัตโนมัติ VPS อาจยังไม่ได้รันงาน{" "}
          <button type="button" className="btn" onClick={() => { setState("polling"); setAttempt((n) => n + 1); }}>ตรวจอีกครั้ง</button>
        </p>
      )}
      {job.output !== null && <pre className="term-output" aria-label="ผลลัพธ์">{job.output === "" ? "(ไม่มีผลลัพธ์)" : job.output}</pre>}
      {job.error !== null && <pre className="term-output term-error" aria-label="ข้อผิดพลาด">{job.error}</pre>}
    </section>
  );
}

export function AdkitTerminalScreen({ me }: { me: Me }) {
  // The server refuses a lower role whatever the UI shows; hiding the form only spares a 403.
  const allowed = roleAtLeast(me.role, PANEL_ROLE_TABLE.useTerminal);
  const [mode, setMode] = useState<TerminalMode>("read");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<TerminalJobView[]>([]);
  const [confirm, confirmDialog] = useConfirm();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (allowed) input.current?.focus(); }, [allowed]);

  const submit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (busy || line.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      // The parse happens on the server (same allowlist as the VPS). A refusal comes back as 422 and no job exists.
      const preview = await api.adkitTerminal({ line, mode, dry_run: true });
      if (mode === "publish") {
        const ok = await confirm({
          title: "ยืนยันเผยแพร่คำสั่งนี้",
          confirmLabel: "ส่งและเผยแพร่",
          tone: "danger",
          body: (
            <div className="term-confirm">
              <p className="term-warn">คำสั่งนี้เขียนข้อมูลจริงใน Google Ads ผ่าน AdKit ทันทีที่ VPS รัน</p>
              <dl>
                <div><dt>โหมด</dt><dd>เผยแพร่</dd></div>
                <div><dt>คำสั่งที่จะรัน</dt><dd>adkit {preview.argv.join(" ")}</dd></div>
              </dl>
            </div>
          ),
        });
        if (!ok) return;
      }
      const sent = await api.adkitTerminal({ line, mode, confirm: mode === "publish" ? true : undefined });
      if (sent.job) setRuns((prev) => [sent.job!, ...prev].slice(0, 5));
      setLine("");
    } catch (err) {
      setError(thaiError(err));
    } finally {
      setBusy(false);
    }
  }, [busy, line, mode, confirm]);

  if (!allowed) {
    return (
      <div className="term-page">
        <h1>AdKit Terminal</h1>
        <p className="term-muted" role="note">หน้านี้สำหรับ Owner เท่านั้น</p>
      </div>
    );
  }

  return (
    <div className="term-page">
      <h1>AdKit Terminal</h1>
      <div className="term-banner">
        <strong>ไม่ใช่ shell</strong>
        <span>ส่งได้ครั้งละหนึ่งคำสั่ง adkit manage google ที่อยู่ในรายการอนุญาต VPS รันงานแล้วส่งผลกลับ ผลลัพธ์ตัดที่ 20 KB และซ่อน click id กับ token</span>
      </div>

      <form className="term-card" aria-label="ส่งคำสั่ง AdKit" onSubmit={(e) => void submit(e)}>
        <div className="term-modes" role="radiogroup" aria-label="โหมด">
          {MODES.map((m) => (
            <label key={m.id} className={`term-mode${mode === m.id ? " on" : ""}`}>
              <input type="radio" name="term-mode" value={m.id} checked={mode === m.id} onChange={() => { setMode(m.id); setError(null); }} />
              <span>{m.label}</span>
              <small>{m.hint}</small>
            </label>
          ))}
        </div>
        <div className="term-field">
          <label htmlFor="term-line">คำสั่ง</label>
          <div className="term-prompt">
            <span aria-hidden="true">adkit</span>
            <input id="term-line" ref={input} type="text" value={line} spellCheck={false} autoComplete="off" placeholder="manage google accounts list"
              onChange={(e) => { setLine(e.target.value); setError(null); }} />
          </div>
        </div>
        {error && <p className="term-reason" role="alert">{error}</p>}
        <div className="term-examples" aria-label="ตัวอย่าง">
          {EXAMPLES[mode].map((ex) => <button key={ex} type="button" className="btn" onClick={() => setLine(ex)}>{ex.length > 60 ? `${ex.slice(0, 57)}...` : ex}</button>)}
        </div>
        <div className="term-foot">
          <button type="submit" className="btn pri" disabled={busy || line.trim() === ""}>{mode === "publish" ? "ตรวจและเผยแพร่" : "ส่งคำสั่ง"}</button>
        </div>
      </form>

      {runs.map((run) => <ResultView key={run.id} first={run} />)}
      {confirmDialog}
    </div>
  );
}
