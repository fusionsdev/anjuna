import type { InstallWithReceipts } from "@anjuna/contracts";

/** The install Workflow's 11 receipted steps, in run order (workers/factory/src/workflows/install.ts). */
export const INSTALL_PROGRESS_STEPS = [
  { step: "validate", label: "ตรวจสอบข้อมูล (Validate)" },
  { step: "save_rollback", label: "บันทึกจุดย้อนกลับ (Save rollback)" },
  { step: "render", label: "สร้างหน้าเว็บ (Render)" },
  { step: "upload_assets", label: "อัปโหลดไฟล์ (Upload assets)" },
  { step: "upload_script", label: "อัปโหลด Worker (Upload script)" },
  { step: "provision_runtime", label: "สร้าง runtime (Provision runtime)" },
  { step: "deploy", label: "ปล่อยเวอร์ชัน (Deploy)" },
  { step: "attach_domains", label: "ผูกโดเมน (Attach domains)" },
  { step: "smoke", label: "ทดสอบหน้าเว็บจริง (Smoke test)" },
  { step: "sync_runtime", label: "ซิงก์ runtime, โฆษณา และรายชื่ออีเมล (Sync runtime, ads, mailing list)" },
  { step: "receipt", label: "ยืนยันผล (Receipt)" },
] as const;

export type StepState = "done" | "failed" | "running" | "pending" | "skipped";

/** Steps this operation runs: provision_runtime only on a first install; a rollback lists the receipts it wrote. */
export function progressSteps(install: InstallWithReceipts): Array<{ step: string; label: string }> {
  if (install.operation === "rollback") {
    return [...new Set(install.receipts.map((r) => r.step))].map((step) => ({ step, label: INSTALL_PROGRESS_STEPS.find((s) => s.step === step)?.label ?? step }));
  }
  const firstInstall = (install.operation ?? "install") === "install";
  return INSTALL_PROGRESS_STEPS.filter((s) => firstInstall || s.step !== "provision_runtime");
}

export function stepStates(install: InstallWithReceipts): Array<{ step: string; label: string; state: StepState; error?: string }> {
  const active = install.status === "queued" || install.status === "running";
  let runningMarked = false;
  return progressSteps(install).map(({ step, label }) => {
    const receipt = install.receipts.find((r) => r.step === step);
    if (receipt?.status === "ready") return { step, label, state: "done" as const };
    if (receipt?.status === "failed") return { step, label, state: "failed" as const, ...(receipt.error ? { error: receipt.error } : {}) };
    if (receipt?.status === "queued") return { step, label, state: "skipped" as const };
    if (active && !runningMarked) { runningMarked = true; return { step, label, state: "running" as const }; }
    return { step, label, state: "pending" as const };
  });
}

/** Known failures, matched on the receipt text the factory writes. Each message is plain Thai + English with the next action. */
const KNOWN_ERRORS: Array<{ code: string; pattern: RegExp; message: string }> = [
  { code: "lifecycle_busy", pattern: /lifecycle mutation in progress/i, message: "แบรนด์นี้มีงานติดตั้งอื่นกำลังทำอยู่ รอให้เสร็จแล้วกด Retry (Another install is running for this brand. Wait for it to finish, then Retry.)" },
  { code: "dns_conflict", pattern: /Existing DNS records block/i, message: "มี DNS record เดิมขวางการผูกโดเมน ลบ record นั้นใน Cloudflare แล้วกด Retry (An existing DNS record blocks the domain. Delete it in Cloudflare, then Retry.)" },
  { code: "zone_missing", pattern: /Zone not found|Zone .* is not active/i, message: "ไม่พบโดเมนใน Cloudflare หรือโดเมนยังไม่ active เพิ่มโดเมนเข้า Cloudflare แล้วกด Retry (The domain is not active in Cloudflare. Add it, then Retry.)" },
  { code: "template_not_sealed", pattern: /Template version is not sealed|Template version not found/i, message: "เทมเพลตยังไม่ถูก seal ให้ Owner seal เทมเพลตก่อน (The template is not sealed. Ask the Owner to seal it.)" },
  { code: "form_artifact", pattern: /Form artifact|form bundle|bundle form version/i, message: "ฟอร์มของแบรนด์ยังไม่พร้อม ให้ Owner ลงทะเบียน form artifact (The lead form artifact is not ready. Ask the Owner to register it.)" },
  { code: "forbidden_bytes", pattern: /forbidden identity|forbidden brand string/i, message: "หน้าเว็บมีคำที่ห้ามใช้ แก้เทมเพลตหรือข้อความแล้วลองใหม่ (The page contains a forbidden word. Fix the template or text, then retry.)" },
  { code: "smoke_dns", pattern: /Smoke: \w+ DNS resolution failed/i, message: "โดเมนยังไม่ชี้มาที่เว็บ (DNS ยังไม่กระจาย) รอสักครู่แล้วกด Retry (DNS has not propagated yet. Wait a few minutes, then Retry.)" },
  { code: "smoke_content", pattern: /Smoke: apex missing expected landing content/i, message: "หน้าเว็บขึ้นแต่ไม่มีช่องคีย์เวิร์ดหรือปุ่มฟอร์ม ตรวจเทมเพลต (The page loads but lacks the keyword slot or form button. Check the template.)" },
  { code: "smoke_status", pattern: /^Smoke: /i, message: "เปิดหน้าเว็บจริงไม่สำเร็จ กด Retry หากยังไม่ได้ให้ตรวจโดเมน (The live page did not answer as expected. Retry; if it persists, check the domain.)" },
  { code: "mailing_list", pattern: /^Mailing list:/i, message: "สร้างรายชื่ออีเมลของแบรนด์ใน listmonk ไม่สำเร็จ ลีดไม่หาย กด Retry (The brand's listmonk list could not be created. No lead is lost. Retry.)" },
  { code: "core_unavailable", pattern: /Core lifecycle request failed \((?:5\d\d|408|429)\)|Core lifecycle verification failed/i, message: "ระบบ Core ไม่ตอบสนองชั่วคราว กด Retry (Core is temporarily unavailable. Retry.)" },
  { code: "core_refused", pattern: /Core lifecycle request failed \(4\d\d\)|Core runtime is not ready|Core credential account mismatch/i, message: "Core ปฏิเสธคำขอ ติดต่อ Owner (Core refused the request. Contact the Owner.)" },
  { code: "cloudflare_api", pattern: /failed: HTTP \d{3}|\(HTTP \d{3}\)|Asset upload failed/i, message: "Cloudflare API ล้มเหลว กด Retry (A Cloudflare API call failed. Retry.)" },
];

export const GENERIC_STEP_ERROR = "ขั้นตอนนี้ล้มเหลว กด Retry เพื่อลองใหม่ (This step failed. Press Retry to try again.)";

/** The plain message for a failed step. Unknown text gets the generic line; the raw text stays behind a Details toggle. */
export function installErrorMessage(raw: string | undefined): { code: string; message: string; known: boolean } {
  const text = rawErrorText(raw ?? "");
  const known = KNOWN_ERRORS.find((entry) => entry.pattern.test(text));
  return known ? { code: known.code, message: known.message, known: true } : { code: "unknown", message: GENERIC_STEP_ERROR, known: false };
}

/** Stored texts may start with "Error: " or be JSON evidence ({"error": ...}); match on the message itself. */
function rawErrorText(stored: string): string {
  let text = stored;
  try {
    const parsed = JSON.parse(stored) as { error?: unknown } | null;
    if (parsed && typeof parsed.error === "string") text = parsed.error;
  } catch { /* plain text */ }
  return text.replace(/^Error: /, "");
}

const stateLabel: Record<StepState, string> = {
  done: "เสร็จ (done)", failed: "ล้มเหลว (failed)", running: "กำลังทำ (running)", pending: "รอ (pending)", skipped: "ข้าม (skipped)",
};

export function InstallProgress({ install, canRetry, onRetry }: { install: InstallWithReceipts; canRetry: boolean; onRetry: () => void }) {
  const steps = stepStates(install);
  const done = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const percent = install.status === "ready" ? 100 : Math.round((done / Math.max(steps.length, 1)) * 100);
  return <div className="install-progress">
    <div role="progressbar" aria-label="ความคืบหน้าการติดตั้ง (Install progress)" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done} className="progress-track">
      <div className={`progress-fill ${install.status}`} style={{ width: `${percent}%` }} />
    </div>
    <p className="muted small">{done}/{steps.length} ขั้นตอน (steps)</p>
    <ol className="progress-steps">{steps.map((s) => {
      const failure = s.state === "failed" ? installErrorMessage(s.error) : null;
      return <li key={s.step} className={`progress-step ${s.state}`} data-step={s.step}>
        <span>{s.label}</span> <span className={`pill ${s.state}`}>{stateLabel[s.state]}</span>
        {failure && <div role="alert" className="error">
          <span>{failure.message}</span>
          {!failure.known && s.error && <details><summary>รายละเอียด (Details)</summary><code>{s.error}</code></details>}
        </div>}
      </li>;
    })}</ol>
    {canRetry && <button className="primary" onClick={onRetry}>ลองใหม่ (Retry)</button>}
  </div>;
}
