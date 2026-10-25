import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuppressionsResponse } from "@anjuna/contracts";
import suppressionsFixture from "@anjuna/contracts/fixtures/admin/suppressions.list.response.json";
import type { Me } from "../src/client/api";
import { SuppressionsScreen } from "../src/client/screens/Suppressions";

const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const fixture = suppressionsFixture as SuppressionsResponse;
const BOUNCED = "bounced.person@example.com";
const COMPLAINER = "complainer@example.com";

let requests: string[];
let firstPage: SuppressionsResponse;
let nextPage: SuppressionsResponse | null;
const fetchMock = vi.fn();
const userList = [{ id: "usr_owner_01", name: "Owner One", email: "owner@example.test", role: "owner", banned: false }];

beforeEach(() => {
  window.history.replaceState(null, "", "/suppressions");
  requests = [];
  firstPage = fixture;
  nextPage = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string) => {
    const url = new URL(input, "https://app.test");
    if (url.pathname === "/api/users") return Response.json({ users: userList });
    if (url.pathname === "/api/suppressions") {
      requests.push(input);
      return Response.json(url.searchParams.has("cursor") && nextPage ? nextPage : firstPage);
    }
    throw new Error(`Unexpected fetch ${input}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const searchBox = () => screen.getByLabelText(/ค้นหาอีเมล/);
const submit = () => fireEvent.click(screen.getByRole("button", { name: "ค้นหา (Search)" }));

describe("Suppressions screen", () => {
  it("searches by value, reason and source and pages by cursor", async () => {
    const second: SuppressionsResponse = {
      rows: [{ email: "zed@example.com", reason: "manual", source: "manual", added_by: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: null }],
      next_cursor: null,
    };
    nextPage = second;
    const { container } = render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    expect(requests).toEqual(["/api/suppressions"]);
    expect(container.textContent).toContain(COMPLAINER);

    fireEvent.change(searchBox(), { target: { value: "Bounced" } });
    fireEvent.change(searchBox(), { target: { value: "Bounced.person" } });
    expect(requests).toHaveLength(1);
    submit();
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toBe("/api/suppressions?q=Bounced.person");

    fireEvent.change(screen.getByLabelText("เหตุผล (Reason)"), { target: { value: "bounce" } });
    await waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toBe("/api/suppressions?q=Bounced.person&reason=bounce");

    fireEvent.change(screen.getByLabelText(/แหล่งที่มา/), { target: { value: "ses" } });
    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]).toBe("/api/suppressions?q=Bounced.person&reason=bounce&source=ses");

    fireEvent.click(await screen.findByRole("button", { name: "ถัดไป (Next)" }));
    await screen.findByText("zed@example.com");
    expect(requests).toHaveLength(5);
    expect(requests[4]).toBe(`/api/suppressions?q=Bounced.person&reason=bounce&source=ses&cursor=${fixture.next_cursor}`);
    expect(screen.queryByRole("button", { name: "ถัดไป (Next)" })).toBeNull();
    expect(screen.queryByText(BOUNCED)).toBeNull();

    // A filter change goes back to page 1.
    fireEvent.change(screen.getByLabelText("เหตุผล (Reason)"), { target: { value: "" } });
    await waitFor(() => expect(requests).toHaveLength(6));
    expect(requests[5]).toBe("/api/suppressions?q=Bounced.person&source=ses");
  });

  it("keeps the search value, reason, source and cursor out of the URL", async () => {
    nextPage = fixture;
    render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    fireEvent.change(searchBox(), { target: { value: "someone@example.com" } });
    fireEvent.change(screen.getByLabelText("เหตุผล (Reason)"), { target: { value: "complaint" } });
    submit();
    await waitFor(() => expect(requests.some((r) => r.includes("q=someone%40example.com"))).toBe(true));
    await screen.findByText(BOUNCED);
    fireEvent.click(screen.getByRole("button", { name: "ถัดไป (Next)" }));
    await waitFor(() => expect(requests.some((r) => r.includes("cursor="))).toBe(true));

    expect(window.location.href).not.toContain("someone");
    expect(window.location.href).not.toContain("example.com");
    expect(window.location.pathname).toBe("/suppressions");
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("states that each search is recorded in the audit log", async () => {
    const { container } = render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    const line = container.querySelector(".sub")!;
    expect(line.textContent).toContain("บันทึกการตรวจสอบ");
    expect(line.textContent).toContain("Each search is recorded in the audit log");
    expect(line.textContent!.indexOf("บันทึกการตรวจสอบ")).toBeLessThan(line.textContent!.indexOf("audit log"));
    expect(line.previousElementSibling!.tagName).toBe("H1");
  });

  it("renders the owner-only panel for an employee and makes no request", async () => {
    const { container } = render(<SuppressionsScreen me={employee} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("สำหรับ Owner เท่านั้น (Owner only)");
    expect(container.textContent).toContain("An employee account cannot open this page.");
    expect(container.textContent).not.toContain("@");
    expect(container.querySelector("table, input, select, form")).toBeNull();
    // Let any effect that wrongly started a request settle before the assertion.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(BOUNCED);
  });

  it("shows an empty state when nothing matches", async () => {
    firstPage = { rows: [], next_cursor: null };
    const { container } = render(<SuppressionsScreen me={owner} />);
    expect(await screen.findByText("ยังไม่มีอีเมลที่ถูกบล็อก (No suppressed emails yet)")).toBeTruthy();

    fireEvent.change(searchBox(), { target: { value: "nobody" } });
    submit();
    expect(await screen.findByText("ไม่พบอีเมลที่ตรงกับตัวกรอง (No suppressed email matches)")).toBeTruthy();
    expect(screen.queryByText(/ยังไม่มีอีเมลที่ถูกบล็อก/)).toBeNull();
  });

  it("renders email, reason badge, source and dates, with an empty updated cell for null", async () => {
    const { container } = render(<SuppressionsScreen me={owner} />);
    const bouncedRow = within((await screen.findByText(BOUNCED)).closest("tr")!);
    expect(bouncedRow.getByText(BOUNCED).closest("td")!.className).toContain("mono");
    expect(bouncedRow.getByText("อีเมลตีกลับ (Bounce)").closest(".pill")!.className).toContain("p-warn");
    expect(bouncedRow.getByText("SES")).toBeTruthy();
    const cells = bouncedRow.getAllByRole("cell").map((c) => c.textContent);
    expect(cells[3]).not.toBe("");
    expect(cells[4]).toBe("");
    const complainerRow = within(screen.getByText(COMPLAINER).closest("tr")!);
    expect(complainerRow.getByText("ร้องเรียน (Complaint)").closest(".pill")!.className).toContain("p-bad");
    expect(complainerRow.getAllByRole("cell")[4]!.textContent).not.toBe("");
    expect(container.textContent).not.toContain("null");
  });

  it("shows a fixed Thai message per HTTP status when the request fails", async () => {
    // The body's error code disagrees with the status: the message follows the status only.
    for (const [status, shown] of [
      [401, "เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง (Session expired)"],
      [403, "สิทธิ์ไม่เพียงพอ (ต้องเป็น Owner)"],
      [500, "ค้นหาไม่สำเร็จ (Search failed)"],
    ] as const) {
      fetchMock.mockImplementation(async (input: string) => {
        if (new URL(input, "https://app.test").pathname === "/api/users") return Response.json({ users: userList });
        return Response.json({ error: "invalid", issues: [{ path: "q", message: BOUNCED }] }, { status });
      });
      const view = render(<SuppressionsScreen me={owner} />);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, String(status)).toBe(shown);
      expect(view.container.textContent, String(status)).not.toContain(BOUNCED);
      view.unmount();
    }
  });

  it("never renders the email an invalid-search response echoes in its issues", async () => {
    const EMAIL = "leaky.person@example.com";
    fetchMock.mockImplementation(async (input: string) => {
      if (new URL(input, "https://app.test").pathname === "/api/users") return Response.json({ users: userList });
      return Response.json(
        { error: "invalid", issues: [{ path: `q=${EMAIL}`, message: `${EMAIL} is not a valid fragment` }] },
        { status: 422 },
      );
    });
    const { container } = render(<SuppressionsScreen me={owner} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("ค่าค้นหาไม่ถูกต้อง (Invalid search)");
    expect(container.textContent).not.toContain(EMAIL);
    expect(container.textContent).not.toContain("leaky");
  });

  it("sends a new request when the same search is submitted again after a failure", async () => {
    let fail = true;
    fetchMock.mockImplementation(async (input: string) => {
      if (new URL(input, "https://app.test").pathname === "/api/users") return Response.json({ users: userList });
      requests.push(input);
      return fail ? Response.json({ error: "boom" }, { status: 500 }) : Response.json(firstPage);
    });
    render(<SuppressionsScreen me={owner} />);
    await screen.findByRole("alert");
    fireEvent.change(searchBox(), { target: { value: "bounced" } });
    submit();
    await waitFor(() => expect(requests).toHaveLength(2));
    await screen.findByRole("alert");
    expect(requests[1]).toBe("/api/suppressions?q=bounced");

    fail = false;
    submit();
    await screen.findByText(BOUNCED);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toBe("/api/suppressions?q=bounced");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not resend an unchanged search after a successful load", async () => {
    render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    fireEvent.change(searchBox(), { target: { value: "bounced" } });
    submit();
    await waitFor(() => expect(requests).toHaveLength(2));
    await screen.findByText(BOUNCED);
    submit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toHaveLength(2);
  });

  it("the add form posts the email and reason and reloads", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions" && (init?.method ?? "GET") === "POST") {
        posts.push({ url: input, body: JSON.parse(String(init?.body)) });
        return Response.json({ email: "new@example.com", reason: "manual", source: "manual", added_by: "u1", created_at: "2026-10-01T00:00:00.000Z", updated_at: null }, { status: 201 });
      }
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    fireEvent.change(screen.getByLabelText("อีเมล (Email)"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText(/เหตุผลสำหรับอีเมลใหม่/), { target: { value: "complaint" } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มอีเมล (Add)" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/suppressions", body: { email: "new@example.com", reason: "complaint" } });
    await waitFor(() => expect(requests.length).toBeGreaterThan(1));
    expect(await screen.findByText("เพิ่ม new@example.com แล้ว (Added new@example.com)")).toBeTruthy();
  });

  it("Remove confirms with the listmonk resync note", async () => {
    const posts: Array<{ url: string; body: unknown }> = [];
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions/remove") {
        posts.push({ url: input, body: JSON.parse(String(init?.body)) });
        return Response.json({ removed: true });
      }
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    render(<SuppressionsScreen me={owner} />);
    const row = (await screen.findByText(BOUNCED)).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "ลบ (Remove)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/Listmonk/)).toBeTruthy();
    expect(within(dialog).getByText(/ซิงก์ครั้งถัดไป/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "ลบ (Remove)" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: "/api/suppressions/remove", body: { email: BOUNCED } });
    expect(await screen.findByText(`ลบ ${BOUNCED} แล้ว (Removed ${BOUNCED})`)).toBeTruthy();
  });

  it("Remove confirms with tone danger", async () => {
    render(<SuppressionsScreen me={owner} />);
    const row = (await screen.findByText(BOUNCED)).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "ลบ (Remove)" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "ลบ (Remove)" }).className).toContain("danger");
  });

  it("a 409 on add shows Already suppressed, not the stale-data message", async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions" && (init?.method ?? "GET") === "POST") {
        return Response.json({ error: "conflict" }, { status: 409 });
      }
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    const { container } = render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    fireEvent.change(screen.getByLabelText("อีเมล (Email)"), { target: { value: BOUNCED } });
    fireEvent.click(screen.getByRole("button", { name: "เพิ่มอีเมล (Add)" }));
    expect(await screen.findByText("อีเมลนี้ถูกบล็อกอยู่แล้ว (Already suppressed)")).toBeTruthy();
    expect(container.textContent).not.toContain("ข้อมูลถูกแก้ไขโดยคนอื่นแล้ว");
  });

  it("a 404 on remove shows Not found", async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions/remove") return Response.json({ error: "not_found" }, { status: 404 });
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    render(<SuppressionsScreen me={owner} />);
    const row = (await screen.findByText(BOUNCED)).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "ลบ (Remove)" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "ลบ (Remove)" }));
    expect(await screen.findByText("ไม่พบอีเมลนี้ (Not found)")).toBeTruthy();
  });

  it("removing the last row of a later page reloads from the first page", async () => {
    nextPage = {
      rows: [{ email: "zed@example.com", reason: "manual", source: "manual", added_by: null, created_at: "2026-10-01T00:00:00.000Z", updated_at: null }],
      next_cursor: null,
    };
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions/remove") return Response.json({ removed: true });
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(url.searchParams.has("cursor") && nextPage ? nextPage : firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    fireEvent.click(await screen.findByRole("button", { name: "ถัดไป (Next)" }));
    const row = (await screen.findByText("zed@example.com")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "ลบ (Remove)" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "ลบ (Remove)" }));
    await waitFor(() => expect(requests.length).toBeGreaterThan(2));
    expect(requests[requests.length - 1]).toBe("/api/suppressions");
  });

  it("cancelling Remove sends no request", async () => {
    let posted = 0;
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.test");
      if (url.pathname === "/api/users") return Response.json({ users: userList });
      if (url.pathname === "/api/suppressions/remove") {
        posted += 1;
        return Response.json({ removed: true });
      }
      if (url.pathname === "/api/suppressions") {
        requests.push(input);
        return Response.json(firstPage);
      }
      throw new Error(`Unexpected fetch ${input}`);
    });
    render(<SuppressionsScreen me={owner} />);
    const row = (await screen.findByText(BOUNCED)).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "ลบ (Remove)" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "ยกเลิก (Cancel)" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(posted).toBe(0);
    expect(screen.queryByText(/ลบ .* แล้ว/)).toBeNull();
  });

  it("the Added by column shows the user name or ระบบ (sync)", async () => {
    render(<SuppressionsScreen me={owner} />);
    const bouncedRow = within((await screen.findByText(BOUNCED)).closest("tr")!);
    expect(bouncedRow.getByText("ระบบ (sync)")).toBeTruthy();
    const complainerRow = within(screen.getByText(COMPLAINER).closest("tr")!);
    expect(complainerRow.getByText("Owner One")).toBeTruthy();
  });

  it("the actor filter sends added_by", async () => {
    render(<SuppressionsScreen me={owner} />);
    await screen.findByText(BOUNCED);
    await screen.findByRole("option", { name: "Owner One (owner@example.test)" });
    const base = requests.length;
    fireEvent.change(screen.getByLabelText(/เพิ่มโดย/), { target: { value: "system" } });
    await waitFor(() => expect(requests).toHaveLength(base + 1));
    expect(requests[base]).toBe("/api/suppressions?added_by=system");
    fireEvent.change(screen.getByLabelText(/เพิ่มโดย/), { target: { value: "usr_owner_01" } });
    await waitFor(() => expect(requests).toHaveLength(base + 2));
    expect(requests[base + 1]).toBe("/api/suppressions?added_by=usr_owner_01");
  });
});
