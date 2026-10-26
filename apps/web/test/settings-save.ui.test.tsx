import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../src/client/router";
import { SettingsScreen } from "../src/client/screens/Settings";
import { answerConfirm } from "./confirm";

const T1 = "2026-10-24T01:02:03.000Z";
const T2 = "2026-10-25T04:05:06.000Z";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const brand = (over: Record<string, unknown> = {}) => BrandConfig.parse({ ...brandFixture.brand, ...over });
const ok = (b: BrandConfig) => ({ brand_id: b.brand_id, hostname: b.hostnames[0]!, brand: b, error: null });

const alpha = brand({
  brand_id: "brand-alpha", hostnames: ["alpha.example.test"], status: "live", aid: "111", prepop_base: "https://lg.example.test/alpha", drain_key: "dk_alpha",
  ab_config: { experiment_id: "exp-alpha", variants: [{ id: "lite_v1", weight: 60 }, { id: "full_v1", weight: 40 }] },
  flow_gate_mode: "signed_cookie", amount_buckets: [500, 1000], keyword_default: "Quick Cash", updated_at: T1,
  theme: { primary: "#0f766e", secondary: "#1e293b" },
});
const beta = brand({
  brand_id: "brand-beta", hostnames: ["beta.example.test"], status: "paused", aid: "222", prepop_base: "https://lg.example.test/beta", drain_key: "dk_beta",
  ab_config: null, flow_gate_mode: "param", amount_buckets: [1500], keyword_default: null, updated_at: T1,
});
const patched = (b: BrandConfig, over: Record<string, unknown>, updated_at = T2) => BrandConfig.parse({ ...b, ...over, updated_at });
const saved = (b: BrandConfig, changed: string[]) => ({ brand: b, changed, audit_id: changed.length ? 7 : null });

type Sent = { method: string; url: string; body: unknown };
let sent: Sent[];
let onPatch: (body: Record<string, unknown>) => Response | Promise<Response>;
let onGetBrand: () => Response;

beforeEach(() => {
  sent = [];
  window.history.replaceState(null, "", "/settings");
  onPatch = () => json({ error: "unexpected" }, 500);
  onGetBrand = () => json({ brand: alpha });
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    sent.push({ method, url: input, body });
    if (method === "GET" && input === "/api/settings/brands") return json({ rows: [ok(alpha), ok(beta)], generated_at: "2026-10-25T00:00:00.000Z" });
    if (method === "PATCH" && input === "/api/brands/brand-alpha") return onPatch(body);
    if (method === "GET" && input === "/api/brands/brand-alpha") return onGetBrand();
    throw new Error(`Unexpected test HTTP request: ${method} ${input}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const patches = () => sent.filter((s) => s.method === "PATCH");
const table = () => screen.getByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
const openEditor = async (domain: string) => {
  await screen.findByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
  const row = within(within(table()).getByText(domain).closest("tr")!);
  fireEvent.click(row.getByRole("button", { name: /แก้ไข \(Edit\)/ }));
};
const drawer = () => screen.queryByRole("complementary", { name: /Edit settings/ });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const review = () => screen.getByRole("button", { name: "ตรวจและบันทึก (Review and save)" }) as HTMLButtonElement;
const DISCARD_TITLE = "ทิ้งการแก้ไขที่ยังไม่บันทึก? (Discard unsaved changes?)";
const MONEY = "ค่านี้เปลี่ยนเส้นทางเงินของแบรนด์ทันที (This changes the brand's money routing at once)";
const REDRAW = "ผู้เข้าชมเดิมจะถูกสุ่มแขนใหม่ (Returning visitors are drawn again)";
const CONFLICT = "มีคนแก้ไขแบรนด์นี้หลังจากคุณเปิด โหลดค่าล่าสุดแล้ว ตรวจการแก้ไขแล้วบันทึกอีกครั้ง (Someone changed this brand after you opened it. The latest values are loaded; review your edits and save again.)";
const dialogOf = async (accept: boolean) => {
  const dialog = await screen.findByRole("alertdialog");
  const text = dialog.textContent ?? "";
  const confirm = within(dialog).getAllByRole("button").find((b) => b.textContent !== "ยกเลิก (Cancel)")!;
  const tone = confirm.className;
  await answerConfirm(accept);
  return { text, tone, dialog };
};

/** Reads the before/after rows of the open review dialog, then answers it. */
const reviewRows = async (accept: boolean) => {
  const dialog = await screen.findByRole("alertdialog");
  const rows = within(dialog).getAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0)
    .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
  await answerConfirm(accept);
  return rows;
};

describe("Settings review and save", () => {
  it("the review dialog lists before and after for each changed field", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("AID (LeadsGate aid)", "999");
    type("เกต (Flow gate)", "param");
    fireEvent.click(review());
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("บันทึกการเปลี่ยนแปลงของ alpha.example.test? (Save changes?)");
    const rows = within(dialog).getAllByRole("row")
      .filter((r) => within(r).queryAllByRole("cell").length > 0)
      .map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["AID (LeadsGate aid)", "111", "999"],
      ["เกต (Flow gate)", "Single Page Cookie", "Keyword Param"],
    ]);
    expect(within(dialog).getByText(MONEY)).toBeTruthy();
    expect(within(dialog).queryByText(REDRAW)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "บันทึก (Save)" }).className).toContain("danger");
    await answerConfirm(false);
  });

  it("a settings-only change has no money line and a default-tone confirm button", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("ช่วงยอดเงิน (Amount buckets)", "500, 2000");
    fireEvent.click(review());
    const { text, tone } = await dialogOf(false);
    expect(text).toContain("500, 1000");
    expect(text).toContain("500, 2000");
    expect(text).not.toContain(MONEY);
    expect(tone).toContain("pri");
  });

  it("Cancel in the review sends no PATCH and keeps the draft", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(patches()).toHaveLength(0);
    expect(drawer()).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");
    expect(review().disabled).toBe(false);
  });

  it("Save sends only the changed fields plus expected_updated_at", async () => {
    onPatch = () => json(saved(patched(alpha, { drain_key: "dk_new" }), ["drain_key"]));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", " dk_new ");
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.url).toBe("/api/brands/brand-alpha");
    expect(patches()[0]!.body).toEqual({ drain_key: "dk_new", expected_updated_at: T1 });
  });

  it("success replaces the row, closes the drawer, shows \"บันทึกแล้ว (Saved)\" and clears the guard", async () => {
    onPatch = () => json(saved(patched(alpha, { drain_key: "dk_new" }), ["drain_key"]));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    expect(drawer()).toBeNull();
    expect(within(table()).getByText("dk_new")).toBeTruthy();
    expect(within(table()).queryByText("dk_alpha")).toBeNull();
    expect(within(table()).getByText("dk_beta")).toBeTruthy();
    // No guard is left behind: leaving is immediate and unasked.
    navigate("/brands");
    expect(window.location.pathname).toBe("/brands");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("an empty changed list shows \"ไม่มีค่าที่เปลี่ยน (Nothing changed)\"", async () => {
    onPatch = () => json(saved(alpha, []));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    expect(await screen.findByText("ไม่มีค่าที่เปลี่ยน (Nothing changed)")).toBeTruthy();
    expect(drawer()).toBeNull();
  });

  it("a new experiment id adds the returning-visitors line", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("น้ำหนักแขน 1 (Arm 1 weight)", "70");
    type("น้ำหนักแขน 2 (Arm 2 weight)", "30");
    fireEvent.click(review());
    expect((await dialogOf(false)).text).not.toContain(REDRAW);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    type("รหัส Experiment (Experiment id)", "exp-next");
    fireEvent.click(review());
    const { text } = await dialogOf(false);
    expect(text).toContain(REDRAW);
    expect(text).toContain("exp-alpha: Lite (lite_v1) 60% / 14 ขั้น (aurum-14-step) 40%");
    expect(text).toContain("exp-next: Lite (lite_v1) 70% / 14 ขั้น (aurum-14-step) 30%");
  });

  it("409 keeps the draft, shows the conflict banner, reloads the brand, and the next save sends the reloaded updated_at", async () => {
    const latest = patched(alpha, { aid: "333" });
    onGetBrand = () => json({ brand: latest });
    onPatch = (body) => (patches().length === 1
      ? json({ error: "conflict", current_updated_at: T2 }, 409)
      : json(saved(patched(latest, { drain_key: body.drain_key, aid: body.aid }, "2026-10-25T09:00:00.000Z"), ["aid", "drain_key"])));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("AID (LeadsGate aid)", "444");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toBe(CONFLICT);
    expect(banner.className).toContain("settings-banner");
    expect(drawer()).toBeTruthy();
    expect((screen.getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("444");
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");
    expect(sent.some((s) => s.method === "GET" && s.url === "/api/brands/brand-alpha")).toBe(true);
    // The table row took the reloaded brand.
    await waitFor(() => expect(within(table()).getByText("333")).toBeTruthy());
    expect(within(table()).queryByText("111")).toBeNull();

    fireEvent.click(review());
    expect(await reviewRows(true)).toEqual([
      ["AID (LeadsGate aid)", "333", "444"],
      ["Drain key", "dk_alpha", "dk_new"],
    ]);
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[0]!.body).toEqual({ aid: "444", drain_key: "dk_new", expected_updated_at: T1 });
    expect(patches()[1]!.body).toEqual({ aid: "444", drain_key: "dk_new", expected_updated_at: T2 });
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    expect(drawer()).toBeNull();
  });

  it("save sends theme with expected_updated_at", async () => {
    onPatch = (body) => json(saved(patched(alpha, body), ["theme"]));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("รหัสสีหลัก (Primary hex)", "#abcdef");
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ theme: { primary: "#abcdef", secondary: "#1e293b" }, expected_updated_at: T1 });
  });

  it("reset sends theme null", async () => {
    onPatch = (body) => json(saved(patched(alpha, body), ["theme"]));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    fireEvent.click(screen.getByRole("button", { name: "ใช้สีของเทมเพลต (Use template colors)" }));
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(patches()[0]!.body).toEqual({ theme: null, expected_updated_at: T1 });
  });

  it("409 keeps the edited colors", async () => {
    onGetBrand = () => json({ brand: patched(alpha, { aid: "333" }) });
    onPatch = () => json({ error: "conflict", current_updated_at: T2 }, 409);
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("รหัสสีหลัก (Primary hex)", "#abcdef");
    fireEvent.click(review());
    await answerConfirm(true);
    await screen.findByText(CONFLICT);
    await waitFor(() => expect((screen.getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("333"));
    expect((screen.getByLabelText("รหัสสีหลัก (Primary hex)") as HTMLInputElement).value).toBe("#abcdef");
  });

  it("after a 409 a field the owner did not edit takes the reloaded value, so the next save does not revert it", async () => {
    const latest = patched(alpha, { aid: "333" });
    onGetBrand = () => json({ brand: latest });
    onPatch = (body) => (patches().length === 1
      ? json({ error: "conflict", current_updated_at: T2 }, 409)
      : json(saved(patched(latest, body, "2026-10-25T09:00:00.000Z"), ["drain_key"])));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);

    await screen.findByText(CONFLICT);
    await waitFor(() => expect((screen.getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("333"));
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");

    fireEvent.click(review());
    expect(await reviewRows(true)).toEqual([["Drain key", "dk_alpha", "dk_new"]]);
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body).toEqual({ drain_key: "dk_new", expected_updated_at: T2 });
    expect(Object.hasOwn(patches()[1]!.body as object, "aid")).toBe(false);
  });

  it("after a 409 an untouched A/B test takes the reloaded A/B test", async () => {
    const latestAb = { experiment_id: "exp-alpha", variants: [{ id: "lite_v1", weight: 20 }, { id: "full_v1", weight: 80 }] };
    const latest = patched(alpha, { ab_config: latestAb });
    onGetBrand = () => json({ brand: latest });
    onPatch = (body) => (patches().length === 1
      ? json({ error: "conflict", current_updated_at: T2 }, 409)
      : json(saved(patched(latest, body, "2026-10-25T09:00:00.000Z"), ["drain_key"])));
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);

    await screen.findByText(CONFLICT);
    await waitFor(() => expect((screen.getByLabelText("น้ำหนักแขน 1 (Arm 1 weight)") as HTMLInputElement).value).toBe("20"));
    expect((screen.getByLabelText("น้ำหนักแขน 2 (Arm 2 weight)") as HTMLInputElement).value).toBe("80");
    fireEvent.click(review());
    expect(await reviewRows(true)).toEqual([["Drain key", "dk_alpha", "dk_new"]]);
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[1]!.body).toEqual({ drain_key: "dk_new", expected_updated_at: T2 });
  });

  it("a failed 409 reload keeps the conflict text and appends the ApiError.thai message", async () => {
    onGetBrand = () => json({ error: "forbidden_role", required_role: "owner" }, 403);
    onPatch = () => json({ error: "conflict", current_updated_at: T2 }, 409);
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    const banner = await screen.findByRole("alert");
    await waitFor(() => expect(banner.textContent).toBe(`${CONFLICT} สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)`));
    expect(drawer()).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");
  });

  it("a 403 shows the ApiError.thai banner and keeps the drawer", async () => {
    onPatch = () => json({ error: "forbidden_role", required_role: "owner" }, 403);
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toBe("สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)");
    expect(drawer()).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");
    expect(review().disabled).toBe(false);
    expect(sent.some((s) => s.method === "GET" && s.url === "/api/brands/brand-alpha")).toBe(false);
  });
});

describe("Settings save in flight", () => {
  let release: (r: Response) => void;
  const startSave = async () => {
    onPatch = () => new Promise<Response>((resolve) => { release = resolve; });
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
  };

  it("the drawer is locked until the answer: typing, Close, the scrim, Escape and Edit on another row do nothing", async () => {
    await startSave();
    const input = screen.getByLabelText("Drain key") as HTMLInputElement;
    expect(input.closest("fieldset")!.disabled).toBe(true);
    type("Drain key", "dk_typed");
    expect(input.value).toBe("dk_new");
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    fireEvent.click(document.querySelector(".scrim")!);
    fireEvent.keyDown(document, { key: "Escape" });
    await openEditor("beta.example.test");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("complementary", { name: "แก้ไขตั้งค่า alpha.example.test (Edit settings)" })).toBeTruthy();
    expect(input.value).toBe("dk_new");
    expect(patches()).toHaveLength(1);

    release(json(saved(patched(alpha, { drain_key: "dk_new" }), ["drain_key"])));
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    expect(drawer()).toBeNull();
    expect(within(table()).getByText("dk_new")).toBeTruthy();
  });

  it("navigate() while a save is in flight stays on /settings and offers no Discard", async () => {
    await startSave();
    navigate("/brands");
    await Promise.resolve();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.location.pathname).toBe("/settings");
    expect(drawer()).toBeTruthy();

    release(json(saved(patched(alpha, { drain_key: "dk_new" }), ["drain_key"])));
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    // findByText has flushed renders, so a Discard dialog opened by navigate() would be on screen by now.
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(window.location.pathname).toBe("/settings");
  });

  /** Releases the deferred PATCH answer and waits until the screen's code has read it and run its follow-up steps. */
  const answer = async (response: Response) => {
    let read!: () => void;
    const handled = new Promise<void>((resolve) => { read = resolve; });
    const readBody = response.json.bind(response);
    response.json = async () => { const data = await readBody(); read(); return data; };
    release(response);
    await handled;
    // Everything after the body read is microtasks, so one macrotask turn is enough.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("unmounting ends the session: a late 200 does not clear the guard of a screen mounted afterwards", async () => {
    const first = render(<SettingsScreen />);
    onPatch = () => new Promise<Response>((resolve) => { release = resolve; });
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    first.unmount();

    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_other");
    const beforeUnload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(beforeUnload()).toBe(true);

    await answer(json(saved(patched(alpha, { drain_key: "dk_new" }), ["drain_key"])));
    expect(beforeUnload()).toBe(true);
    expect(screen.queryByText("บันทึกแล้ว (Saved)")).toBeNull();
    expect(within(table()).getByText("dk_alpha")).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_other");
    navigate("/brands");
    expect(within(await screen.findByRole("alertdialog")).getByRole("heading").textContent).toBe(DISCARD_TITLE);
    expect(window.location.pathname).toBe("/settings");
    await answerConfirm(false);
  });

  it("a late 409 after unmount shows no banner and reloads nothing", async () => {
    const first = render(<SettingsScreen />);
    onPatch = () => new Promise<Response>((resolve) => { release = resolve; });
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    first.unmount();

    render(<SettingsScreen />);
    await screen.findByRole("table", { name: "ตั้งค่าแบรนด์ (Brand settings)" });
    await answer(json({ error: "conflict", current_updated_at: T2 }, 409));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(sent.some((s) => s.method === "GET" && s.url === "/api/brands/brand-alpha")).toBe(false);
    await openEditor("beta.example.test");
    expect(await screen.findByRole("complementary", { name: "แก้ไขตั้งค่า beta.example.test (Edit settings)" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Settings unsaved-change guard", () => {
  it("closing the drawer while clean asks nothing", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(drawer()).toBeNull();
  });

  it("closing the drawer while dirty asks to discard; Cancel keeps the draft; Discard closes", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    const asked = await screen.findByRole("alertdialog");
    expect(within(asked).getByRole("heading").textContent).toBe(DISCARD_TITLE);
    expect(within(asked).getByRole("button", { name: "ทิ้งการแก้ไข (Discard)" }).className).toContain("danger");
    await answerConfirm(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(drawer()).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");

    fireEvent.keyDown(document, { key: "Escape" });
    await answerConfirm(true);
    await waitFor(() => expect(drawer()).toBeNull());
    expect(patches()).toHaveLength(0);

    // Opening the row again starts from the loaded values.
    await openEditor("alpha.example.test");
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_alpha");
  });

  it("opening another row while dirty asks to discard", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    await openEditor("beta.example.test");
    expect(within(await screen.findByRole("alertdialog")).getByRole("heading").textContent).toBe(DISCARD_TITLE);
    await answerConfirm(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("complementary", { name: "แก้ไขตั้งค่า alpha.example.test (Edit settings)" })).toBeTruthy();
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");

    await openEditor("beta.example.test");
    await answerConfirm(true);
    expect(await screen.findByRole("complementary", { name: "แก้ไขตั้งค่า beta.example.test (Edit settings)" })).toBeTruthy();
    expect((screen.getByLabelText("AID (LeadsGate aid)") as HTMLInputElement).value).toBe("222");
  });

  it("sidebar-style navigate(\"/brands\") while dirty asks; Cancel stays on /settings; Discard leaves", async () => {
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    navigate("/brands");
    expect(within(await screen.findByRole("alertdialog")).getByRole("heading").textContent).toBe(DISCARD_TITLE);
    await answerConfirm(false);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(window.location.pathname).toBe("/settings");
    expect((screen.getByLabelText("Drain key") as HTMLInputElement).value).toBe("dk_new");

    navigate("/brands");
    await answerConfirm(true);
    await waitFor(() => expect(window.location.pathname).toBe("/brands"));
    // The discard cleared the guard before the router asked again: one question only.
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("unmounting while dirty leaves no guard behind", async () => {
    const view = render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    view.unmount();
    navigate("/brands");
    expect(window.location.pathname).toBe("/brands");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("a beforeunload listener exists only while dirty", async () => {
    const fire = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    render(<SettingsScreen />);
    await openEditor("alpha.example.test");
    expect(fire()).toBe(false);
    type("Drain key", "dk_new");
    expect(fire()).toBe(true);
    type("Drain key", "dk_alpha");
    expect(fire()).toBe(false);
    type("Drain key", "dk_new");
    expect(fire()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    await answerConfirm(true);
    await waitFor(() => expect(drawer()).toBeNull());
    expect(fire()).toBe(false);
  });
});
