import { BrandConfig } from "@anjuna/contracts";
import brandFixture from "@anjuna/contracts/fixtures/admin/brand.get.response.json";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../src/client/router";
import { SettingsScreen } from "../src/client/screens/Settings";
import { answerConfirm } from "./confirm";

const owner = { id: "owner", email: "owner@example.test", role: "owner" as const };
const T1 = "2026-10-24T01:02:03.000Z";
const T2 = "2026-10-25T04:05:06.000Z";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const brand = (over: Record<string, unknown> = {}) => BrandConfig.parse({ ...brandFixture.brand, ...over });
const ok = (b: BrandConfig) => ({ brand_id: b.brand_id, hostname: b.hostnames[0]!, brand: b, error: null });

const alpha = brand({
  brand_id: "brand-alpha", hostnames: ["alpha.example.test"], status: "live", aid: "111", prepop_base: "https://lg.example.test/alpha", drain_key: "dk_alpha",
  ab_config: { experiment_id: "exp-alpha", variants: [{ id: "lite_v1", weight: 60 }, { id: "full_v1", weight: 40 }] },
  flow_gate_mode: "signed_cookie", amount_buckets: [500, 1000], keyword_default: "Quick Cash", updated_at: T1,
});
const beta = brand({
  brand_id: "brand-beta", hostnames: ["beta.example.test"], status: "paused", aid: "222", prepop_base: "https://lg.example.test/beta", drain_key: "dk_beta",
  ab_config: null, flow_gate_mode: "param", amount_buckets: [1500], keyword_default: null, updated_at: T1,
});
const patched = (b: BrandConfig, over: Record<string, unknown>, updated_at = T2) => BrandConfig.parse({ ...b, ...over, updated_at });
const saved = (b: BrandConfig, changed: string[]) => ({ brand: b, changed, audit_id: changed.length ? 7 : null });

type Sent = { method: string; url: string; body: unknown };
let sent: Sent[];
let onPatch: (body: Record<string, unknown>) => Response;
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

describe("Settings review and save", () => {
  it("the review dialog lists before and after for each changed field", async () => {
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
    await openEditor("alpha.example.test");
    type("Drain key", "dk_new");
    fireEvent.click(review());
    await answerConfirm(true);
    expect(await screen.findByText("ไม่มีค่าที่เปลี่ยน (Nothing changed)")).toBeTruthy();
    expect(drawer()).toBeNull();
  });

  it("a new experiment id adds the returning-visitors line", async () => {
    render(<SettingsScreen me={owner} />);
    await openEditor("alpha.example.test");
    type("น้ำหนักแขน 1 (Arm 1 weight)", "70");
    type("น้ำหนักแขน 2 (Arm 2 weight)", "30");
    fireEvent.click(review());
    expect((await dialogOf(false)).text).not.toContain(REDRAW);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    type("Experiment id", "exp-next");
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
    render(<SettingsScreen me={owner} />);
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
    const { text } = await dialogOf(true);
    expect(text).toContain("333");
    expect(text).toContain("444");
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(patches()[0]!.body).toEqual({ aid: "444", drain_key: "dk_new", expected_updated_at: T1 });
    expect(patches()[1]!.body).toEqual({ aid: "444", drain_key: "dk_new", expected_updated_at: T2 });
    expect(await screen.findByText("บันทึกแล้ว (Saved)")).toBeTruthy();
    expect(drawer()).toBeNull();
  });

  it("a 403 shows the ApiError.thai banner and keeps the drawer", async () => {
    onPatch = () => json({ error: "forbidden_role", required_role: "owner" }, 403);
    render(<SettingsScreen me={owner} />);
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

describe("Settings unsaved-change guard", () => {
  it("closing the drawer while clean asks nothing", async () => {
    render(<SettingsScreen me={owner} />);
    await openEditor("alpha.example.test");
    fireEvent.click(screen.getByRole("button", { name: "ปิด (Close)" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(drawer()).toBeNull();
  });

  it("closing the drawer while dirty asks to discard; Cancel keeps the draft; Discard closes", async () => {
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
    const view = render(<SettingsScreen me={owner} />);
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
    render(<SettingsScreen me={owner} />);
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
