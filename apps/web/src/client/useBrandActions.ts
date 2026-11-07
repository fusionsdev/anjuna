import { createElement, Fragment, type ReactNode, useCallback, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { Toast } from "./components/Toast";
import { useConfirm } from "./components/ConfirmDialog";
import { navigate, routePath } from "./router";

export type BrandAction = "test-sold" | "retry-install" | "approve-template" | "set-route";

/** The brand a dialog names. `installId` is the install Retry repeats; `templateId` is the template version Approve certifies. */
export interface ActionBrand { id: string; name: string; domain: string; installId?: string | null; templateId?: string | null }

const keyOf = (action: BrandAction, brand: ActionBrand) => `${action}:${brand.id}`;
const label = (brand: ActionBrand) => `${brand.name} · ${brand.domain}`;

const COPY: Record<Exclude<BrandAction, "set-route">, { title: (b: ActionBrand) => string; body: (b: ActionBrand) => string; confirm: string; done: (b: ActionBrand) => string; tone?: "danger" }> = {
  "test-sold": {
    title: (b) => `ยืนยัน Test sold ของ ${label(b)}?`,
    body: (b) => `ยืนยันว่ามีลีดทดสอบของ ${label(b)} ขายได้จริง กรอก lead_id ที่ตรวจแล้ว`,
    confirm: "ยืนยัน",
    done: (b) => `ยืนยัน Test sold ของ ${b.domain} แล้ว`,
  },
  "retry-install": {
    title: (b) => `ลองติดตั้ง ${label(b)} ใหม่?`,
    body: (b) => `ระบบจะติดตั้ง ${label(b)} ซ้ำจากครั้งที่ล้มเหลว`,
    confirm: "ลองใหม่",
    done: (b) => `เริ่มติดตั้ง ${b.domain} ใหม่แล้ว`,
  },
  "approve-template": {
    title: (b) => `อนุมัติเทมเพลตของ ${label(b)}?`,
    body: (b) => `เทมเพลตที่ ${label(b)} รออยู่จะถูกอนุมัติ เฉพาะเจ้าของทำได้`,
    confirm: "อนุมัติเทมเพลต",
    done: (b) => `อนุมัติเทมเพลตของ ${b.domain} แล้ว`,
  },
};

const failureText = (error: unknown) => (error instanceof ApiError ? error.thai : "ดำเนินการไม่สำเร็จ");

/** Rows for the Test sold dialog: each brand with its own lead_id field. Values go into `leads` as they are typed, so they outlive the dialog. */
function leadRows(brands: ActionBrand[], leads: Record<string, string>): ReactNode {
  return createElement("ul", { className: "confirm-brands" }, brands.map((brand) => createElement("li", { key: brand.id },
    createElement("b", null, brand.name), ` · ${brand.domain} `,
    createElement("input", {
      "aria-label": `lead_id ${brand.domain}`,
      placeholder: "lead_id",
      defaultValue: "",
      onChange: (event: { target: { value: string } }) => { leads[brand.id] = event.target.value; },
    }),
  )));
}

/**
 * One path for the actions a person starts from a brand row: a dialog that names the brand and its domain, then one request.
 * A request for the same action and brand that is still pending is ignored. Role gating stays on the server, and a refusal shows as a toast.
 * `view` holds the dialog and the toast; render it once in the screen.
 */
export function useBrandActions(options: { onDone?: () => void; onSetRoute?: (brand: ActionBrand) => void } = {}) {
  const [confirm, dialog] = useConfirm();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ id: number; kind: "ok" | "err"; text: string } | null>(null);
  const seq = useRef(0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const show = useCallback((kind: "ok" | "err", text: string) => setToast({ id: (seq.current += 1), kind, text }), []);
  const dismiss = useCallback(() => setToast(null), []);

  const hold = (keys: string[]) => { for (const key of keys) inFlight.current.add(key); setPending(new Set(inFlight.current)); };
  const release = (keys: string[]) => { for (const key of keys) inFlight.current.delete(key); setPending(new Set(inFlight.current)); };

  const send = async (action: BrandAction, brand: ActionBrand, lead?: string): Promise<void> => {
    switch (action) {
      case "test-sold": await api.attestChecklist(brand.id, "test_sold", lead); return;
      case "retry-install":
        if (!brand.installId) throw new Error("no install to retry");
        await api.retryInstall(brand.installId);
        return;
      case "approve-template":
        if (!brand.templateId) throw new Error("no template waiting");
        await api.approveTemplate(brand.templateId);
        return;
      case "set-route": return;
    }
  };

  const run = useCallback(async (action: BrandAction, brand: ActionBrand): Promise<void> => {
    if (action === "set-route") {
      // Opening the route form changes nothing, so it needs no question.
      if (optionsRef.current.onSetRoute) optionsRef.current.onSetRoute(brand);
      else navigate(routePath({ view: "brands", brandId: brand.id }));
      return;
    }
    const key = keyOf(action, brand);
    if (inFlight.current.has(key)) return;
    const leads: Record<string, string> = {};
    const copy = COPY[action];
    const ok = await confirm({
      title: copy.title(brand),
      body: action === "test-sold" ? createElement(Fragment, null, createElement("p", null, copy.body(brand)), leadRows([brand], leads)) : copy.body(brand),
      confirmLabel: copy.confirm,
    });
    // The same action may have been confirmed while this dialog was open.
    if (!ok || inFlight.current.has(key)) return;
    const lead = leads[brand.id]?.trim();
    if (action === "test-sold" && !lead) { show("err", `กรอก lead_id ของ ${brand.domain} ก่อนยืนยัน Test sold`); return; }
    hold([key]);
    try {
      await send(action, brand, lead);
      show("ok", copy.done(brand));
      optionsRef.current.onDone?.();
    } catch (error) {
      show("err", failureText(error));
    } finally {
      release([key]);
    }
  }, [confirm, show]);

  /** One request per brand, in order. The first failure stops the rest and names its brand. */
  const runBatch = useCallback(async (action: "test-sold", brands: ActionBrand[]): Promise<void> => {
    const todo = brands.filter((brand) => !inFlight.current.has(keyOf(action, brand)));
    if (todo.length === 0) return;
    const leads: Record<string, string> = {};
    const copy = COPY[action];
    const ok = await confirm({
      title: `ยืนยัน Test sold ${todo.length} แบรนด์?`,
      body: createElement(Fragment, null, createElement("p", null, "กรอก lead_id ที่ตรวจแล้วของแต่ละแบรนด์ ระบบส่งทีละแบรนด์และหยุดเมื่อมีแบรนด์ที่ไม่สำเร็จ"), leadRows(todo, leads)),
      confirmLabel: copy.confirm,
    });
    if (!ok) return;
    const missing = todo.find((brand) => !leads[brand.id]?.trim());
    if (missing) { show("err", `กรอก lead_id ของ ${missing.domain} ก่อนยืนยัน Test sold`); return; }
    const keys = todo.map((brand) => keyOf(action, brand));
    if (keys.some((key) => inFlight.current.has(key))) return;
    hold(keys);
    let done = 0;
    try {
      for (const brand of todo) {
        try {
          await send(action, brand, leads[brand.id]!.trim());
        } catch (error) {
          show("err", `ยืนยัน Test sold ไม่สำเร็จที่ ${brand.domain}: ${failureText(error)} ส่งสำเร็จแล้ว ${done} จาก ${todo.length} แบรนด์`);
          return;
        } finally {
          release([keyOf(action, brand)]);
        }
        done += 1;
      }
      show("ok", `ยืนยัน Test sold แล้ว ${done} แบรนด์`);
    } finally {
      release(keys);
      if (done > 0) optionsRef.current.onDone?.();
    }
  }, [confirm, show]);

  const view = createElement(Fragment, null, dialog, toast ? createElement(Toast, { key: toast.id, kind: toast.kind, text: toast.text, onDismiss: dismiss }) : null);
  return { run, runBatch, pending, view };
}
