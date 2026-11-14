import { createElement, Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api";
import { Toast } from "./components/Toast";
import { useConfirm } from "./components/ConfirmDialog";
import { navigate, routePath } from "./router";

export type BrandAction = "test-sold" | "retry-install" | "approve-template" | "set-route";

/** The brand a dialog names. `installId` is the install Retry repeats; `templateId` is the template version Approve certifies. */
export interface ActionBrand { id: string; name: string; domain: string; installId?: string | null; templateId?: string | null; templateLabel?: string | null }

const keyOf = (action: BrandAction, brand: ActionBrand) => `${action}:${brand.id}`;
const label = (brand: ActionBrand) => `${brand.name} · ${brand.domain}`;

const COPY: Record<Exclude<BrandAction, "set-route">, { title: (b: ActionBrand) => string; body: (b: ActionBrand) => string; confirm: string; done: (b: ActionBrand) => string; tone?: "danger" }> = {
  "test-sold": {
    title: (b) => `ยืนยันการทดสอบการขายของ ${label(b)}?`,
    body: (b) => `ยืนยันว่ามีลีดทดสอบของ ${label(b)} ขายได้จริง กรอก lead_id ที่ตรวจแล้ว`,
    confirm: "ยืนยัน",
    done: (b) => `ยืนยันการทดสอบการขายของ ${b.domain} แล้ว`,
  },
  "retry-install": {
    title: (b) => `ลองติดตั้ง ${label(b)} ใหม่?`,
    body: (b) => `ระบบจะติดตั้ง ${label(b)} ซ้ำจากครั้งที่ล้มเหลว`,
    confirm: "ลองใหม่",
    done: (b) => `เริ่มติดตั้ง ${b.domain} ใหม่แล้ว`,
  },
  "approve-template": {
    title: (b) => `อนุมัติเทมเพลตของ ${label(b)}?`,
    body: (b) => `เทมเพลต ${b.templateLabel ?? "ที่รออนุมัติ"} ของ ${label(b)} จะถูกอนุมัติ เวอร์ชันที่ปิดผนึกแล้วใช้ร่วมกันทุกแบรนด์ที่ใช้เวอร์ชันนี้ เฉพาะเจ้าของทำได้`,
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
      defaultValue: leads[brand.id] ?? "",
      onChange: (event: { target: { value: string } }) => { leads[brand.id] = event.target.value; },
    }),
  )));
}

/**
 * One path for the actions a person starts from a brand row: a dialog that names the brand and its domain, then one request.
 * A request for the same action and brand that is still pending is ignored. Role gating stays on the server, and a refusal shows as a toast.
 * `view` holds the dialog and the toast; render it once in the screen.
 */
export function useBrandActions(options: { onDone?: (action: BrandAction, brands: ActionBrand[]) => void; onSetRoute?: (brand: ActionBrand) => void } = {}) {
  const [confirm, dialog] = useConfirm();
  const inFlight = useRef(new Set<string>());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<{ id: number; kind: "ok" | "err"; text: string } | null>(null);
  const seq = useRef(0);
  // Bumped by every new run and by unmount. An answer that arrives for an older generation is dropped, so a late read cannot open a dialog, toast or navigate.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, []);
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

  /** Asks for a lead_id per brand. An empty field keeps the dialog open with a message; only Cancel or a full set ends it. */
  const askLeads = useCallback(async (title: string, intro: string, brands: ActionBrand[], leads: Record<string, string>, confirmLabel: string): Promise<boolean> => {
    let problem: string | null = null;
    for (;;) {
      const ok = await confirm({
        title,
        body: createElement(Fragment, null, createElement("p", null, intro), problem ? createElement("p", { role: "alert", className: "error" }, problem) : null, leadRows(brands, leads)),
        confirmLabel,
      });
      if (!ok) return false;
      const missing = brands.find((brand) => !leads[brand.id]?.trim());
      if (!missing) return true;
      problem = `กรอก lead_id ของ ${missing.domain} ก่อนยืนยันการทดสอบการขาย`;
    }
  }, [confirm]);

  const run = useCallback(async (action: BrandAction, brand: ActionBrand): Promise<void> => {
    if (action === "set-route") {
      // Opening the route form changes nothing, so it needs no question.
      if (optionsRef.current.onSetRoute) optionsRef.current.onSetRoute(brand);
      else navigate(routePath({ view: "brands", brandId: brand.id }));
      return;
    }
    const key = keyOf(action, brand);
    if (inFlight.current.has(key)) return;
    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine;
    const leads: Record<string, string> = {};
    const copy = COPY[action];
    if (action === "retry-install") {
      // A failed install that holds recovery evidence is refused by Retry (409). Brands offers Recover for it, so the brand page opens instead.
      if (!brand.installId) { show("err", "ไม่พบการติดตั้งที่จะลองใหม่"); return; }
      try {
        const detail = await api.installDetail(brand.installId);
        if (stale()) return;
        if (detail.recovery_required === true) {
          // The brand page offers Recover. A toast here would be gone before that page renders, so none is shown.
          navigate(routePath({ view: "brands", brandId: brand.id }));
          return;
        }
      } catch (error) {
        if (!stale()) show("err", failureText(error));
        return;
      }
    }
    const ok = action === "test-sold"
      ? await askLeads(copy.title(brand), copy.body(brand), [brand], leads, copy.confirm)
      : await confirm({ title: copy.title(brand), body: copy.body(brand), confirmLabel: copy.confirm });
    // The same action may have been confirmed while this dialog was open.
    if (!ok || inFlight.current.has(key)) return;
    const lead = leads[brand.id]?.trim();
    hold([key]);
    try {
      await send(action, brand, lead);
      show("ok", copy.done(brand));
      optionsRef.current.onDone?.(action, [brand]);
    } catch (error) {
      show("err", failureText(error));
    } finally {
      release([key]);
    }
  }, [confirm, show, askLeads]);

  /** One request per brand, in order. The first failure stops the rest and names its brand. */
  const runBatch = useCallback(async (action: "test-sold", brands: ActionBrand[]): Promise<void> => {
    const todo = brands.filter((brand) => !inFlight.current.has(keyOf(action, brand)));
    if (todo.length === 0) return;
    // A run still reading an install must not open its dialog over this batch dialog.
    generation.current += 1;
    const leads: Record<string, string> = {};
    const copy = COPY[action];
    const ok = await askLeads(`ยืนยันการทดสอบการขาย ${todo.length} แบรนด์?`, "กรอก lead_id ที่ตรวจแล้วของแต่ละแบรนด์ ระบบส่งทีละแบรนด์และหยุดเมื่อมีแบรนด์ที่ไม่สำเร็จ", todo, leads, copy.confirm);
    if (!ok) return;
    const keys = todo.map((brand) => keyOf(action, brand));
    if (keys.some((key) => inFlight.current.has(key))) return;
    hold(keys);
    let done = 0;
    try {
      for (const brand of todo) {
        try {
          await send(action, brand, leads[brand.id]!.trim());
        } catch (error) {
          show("err", `ยืนยันการทดสอบการขายไม่สำเร็จที่ ${brand.domain}: ${failureText(error)} ส่งสำเร็จแล้ว ${done} จาก ${todo.length} แบรนด์`);
          return;
        } finally {
          release([keyOf(action, brand)]);
        }
        done += 1;
      }
      show("ok", `ยืนยันการทดสอบการขายแล้ว ${done} แบรนด์`);
    } finally {
      release(keys);
      if (done > 0) optionsRef.current.onDone?.(action, todo.slice(0, done));
    }
  }, [confirm, show, askLeads]);

  /** Drops answers of runs that already started: a screen calls it when its selection changes, so a late read cannot open a dialog for the old brand. */
  const invalidate = useCallback(() => { generation.current += 1; }, []);

  const view = createElement(Fragment, null, dialog, toast ? createElement(Toast, { key: toast.id, kind: toast.kind, text: toast.text, onDismiss: dismiss }) : null);
  return { run, runBatch, invalidate, pending, view };
}
