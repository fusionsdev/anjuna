import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetLeadResponse } from "@anjuna/contracts";
import ownerFixture from "@anjuna/contracts/fixtures/admin/lead.get.response.json";
import employeeFixture from "@anjuna/contracts/fixtures/admin/lead.get.response.employee.json";
import type { Me } from "../src/client/api";
import { LeadDetailScreen } from "../src/client/screens/LeadDetail";

const LEAD_ID = "6f1c2b9e-3a4d-4c5e-8f60-7a8b9c0d1e2f";
const owner: Me = { id: "u1", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "u2", email: "staff@example.test", role: "employee" };
const NOTICE = "ข้อมูลส่วนบุคคลสงวนสำหรับ Owner (Personal data is owner-only)";
const SOLD_NO_UPLOAD = "ขายแล้วแต่ไม่มีรายการอัปโหลด";
const DEAD = "อัปโหลดล้มเหลวถาวร";
const UPLOADED = "ส่งคอนเวอร์ชันแล้ว";
const NO_POSTBACK = "ผู้ซื้อยังไม่แจ้งผล";
const PAYOUT_HEADER = "ค่าตอบแทน (Payout)";

type Lead = GetLeadResponse["lead"];
const ownerLead = (): Lead => structuredClone((ownerFixture as GetLeadResponse).lead);
const employeeLead = (): Lead => structuredClone((employeeFixture as GetLeadResponse).lead);

let requests: string[];
let answer: { status: number; body: unknown };
const respondWith = (lead: Lead) => { answer = { status: 200, body: { lead } }; };

beforeEach(() => {
  window.history.replaceState(null, "", `/leads/${LEAD_ID}`);
  requests = [];
  respondWith(ownerLead());
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    requests.push(input);
    const url = new URL(input, "https://app.test");
    if (url.pathname === `/api/leads/${LEAD_ID}`) return Response.json(answer.body, { status: answer.status });
    throw new Error(`Unexpected fetch ${input}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderScreen = async (me: Me = owner) => {
  const view = render(<LeadDetailScreen me={me} leadId={LEAD_ID} onBack={() => {}} />);
  await screen.findByText("ผลจากผู้ซื้อ");
  return view;
};
const rowOf = (label: string) => within(screen.getByText(label).closest("tr")!);
const pillOf = (text: string) => screen.getByText(text).closest(".pill")!;
const reconciliation = () => screen.getByRole("status", { name: "ตรวจยอด (Reconciliation)" });

describe("Lead detail screen", () => {
  it("shows the applicant block and the payout column to an owner", async () => {
    const { container } = await renderScreen();
    expect(requests).toEqual([`/api/leads/${LEAD_ID}`]);
    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(rowOf("อีเมล (Email)").getByText("test.applicant@example.com")).toBeTruthy();
    expect(rowOf("ชื่อ (First name)").getByText("Test")).toBeTruthy();
    expect(rowOf("ที่อยู่ (Address)").getByText("100 Example St")).toBeTruthy();
    expect(rowOf("รหัสไปรษณีย์ (ZIP)").getByText("75201")).toBeTruthy();
    expect(rowOf("วันเกิด (Birth date)").getByText("1990-01-15")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: PAYOUT_HEADER })).toBeTruthy();
    expect(within(screen.getByLabelText("รายการผลจากผู้ซื้อ")).getByText("$85")).toBeTruthy();
    expect(rowOf("มูลค่า (Value)").getByText("$85")).toBeTruthy();
    expect(container.textContent).toContain("Fast Cash Loans");
    expect(within(screen.getByLabelText("รายการผลจากผู้ซื้อ")).getAllByRole("row")).toHaveLength(3);
  });

  it("hides the applicant block and the payout column from an employee and says why", async () => {
    respondWith(employeeLead());
    const { container } = await renderScreen(employee);
    const text = container.textContent!;
    expect(text.split(NOTICE)).toHaveLength(2);
    for (const pii of ["test.applicant@example.com", "1990-01-15", "2145550123", "100 Example St", "Dallas", "75201"]) {
      expect(text, pii).not.toContain(pii);
    }
    for (const label of ["ชื่อ (First name)", "นามสกุล (Last name)", "อีเมล (Email)", "วันเกิด (Birth date)", "เบอร์บ้าน (Home phone)", "เบอร์ที่ทำงาน (Work phone)", "ที่อยู่ (Address)", "เมือง (City)", "รหัสไปรษณีย์ (ZIP)"]) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    expect(screen.queryByRole("columnheader", { name: PAYOUT_HEADER })).toBeNull();
    expect(screen.queryByText("มูลค่า (Value)")).toBeNull();
    expect(screen.queryByText("$85")).toBeNull();
    const postbacks = within(screen.getByLabelText("รายการผลจากผู้ซื้อ"));
    expect(postbacks.getAllByRole("columnheader")).toHaveLength(2);
    expect(postbacks.getAllByRole("row")).toHaveLength(3);
    // Profile is not PII: the employee still reads it.
    expect(rowOf("นายจ้าง (Employer)").getByText("Example Co")).toBeTruthy();
    expect(rowOf("รัฐ (State)").getByText("TX")).toBeTruthy();
  });

  it("shows sold with no conversion upload as an alert", async () => {
    const lead = ownerLead();
    lead.conversion = null;
    respondWith(lead);
    await renderScreen();
    expect(within(reconciliation()).getByText(SOLD_NO_UPLOAD)).toBeTruthy();
    expect(pillOf(SOLD_NO_UPLOAD).className).toContain("p-bad");
    expect(screen.queryByText(UPLOADED)).toBeNull();
    expect(screen.queryByText(DEAD)).toBeNull();
    expect(screen.queryByText(NO_POSTBACK)).toBeNull();
  });

  it("shows a dead upload as an alert and an uploaded one as ok", async () => {
    const dead = ownerLead();
    dead.conversion = { ...dead.conversion!, status: "dead" };
    respondWith(dead);
    const first = await renderScreen();
    expect(pillOf(DEAD).className).toContain("p-bad");
    expect(screen.queryByText(UPLOADED)).toBeNull();
    expect(screen.queryByText(SOLD_NO_UPLOAD)).toBeNull();
    first.unmount();

    respondWith(ownerLead());
    await renderScreen();
    expect(pillOf(UPLOADED).className).toContain("p-live");
    expect(screen.queryByText(DEAD)).toBeNull();
    expect(screen.queryByText(SOLD_NO_UPLOAD)).toBeNull();
  });

  it("shows no postback yet as a warning", async () => {
    const lead = ownerLead();
    lead.postbacks = [];
    lead.conversion = null;
    lead.status = "accepted";
    lead.outcome = "pending";
    respondWith(lead);
    await renderScreen();
    expect(pillOf(NO_POSTBACK).className).toContain("p-warn");
    expect(screen.queryByText(SOLD_NO_UPLOAD)).toBeNull();
    expect(screen.getByRole("columnheader", { name: PAYOUT_HEADER })).toBeTruthy();
    expect(within(screen.getByLabelText("รายการผลจากผู้ซื้อ")).getByText("ยังไม่มีผลจากผู้ซื้อ")).toBeTruthy();
  });

  it("keeps the payout column and the Value row for an owner when every amount is null", async () => {
    const lead = ownerLead();
    lead.postbacks = lead.postbacks.map((p) => ({ ...p, payout: null }));
    lead.conversion = { ...lead.conversion!, value: null };
    respondWith(lead);
    await renderScreen();
    const postbacks = within(screen.getByLabelText("รายการผลจากผู้ซื้อ"));
    expect(postbacks.getByRole("columnheader", { name: PAYOUT_HEADER })).toBeTruthy();
    const headers = postbacks.getAllByRole("columnheader").map((h) => h.textContent);
    const payoutAt = headers.indexOf(PAYOUT_HEADER);
    const body = postbacks.getAllByRole("row").slice(1);
    expect(body).toHaveLength(lead.postbacks.length);
    for (const row of body) expect(within(row).getAllByRole("cell")[payoutAt]!.textContent).toBe("");
    expect(rowOf("มูลค่า (Value)").getAllByRole("cell")[0]!.textContent).toBe("");
  });

  it("shows only the upload line when the upload is final and there are no postbacks", async () => {
    for (const [status, shown, hidden] of [["uploaded", UPLOADED, DEAD], ["dead", DEAD, UPLOADED]] as const) {
      const lead = ownerLead();
      lead.postbacks = [];
      lead.conversion = { ...lead.conversion!, status };
      respondWith(lead);
      const view = await renderScreen();
      expect(within(reconciliation()).getByText(shown), status).toBeTruthy();
      expect(screen.queryByText(hidden), status).toBeNull();
      expect(screen.queryByText(NO_POSTBACK), status).toBeNull();
      expect(screen.queryByText(SOLD_NO_UPLOAD), status).toBeNull();
      view.unmount();
    }
  });

  it("shows no reconciliation line for a sold lead whose upload is pending or processing", async () => {
    for (const status of ["pending", "processing"] as const) {
      const lead = ownerLead();
      lead.conversion = { ...lead.conversion!, status };
      respondWith(lead);
      const view = await renderScreen();
      expect(screen.queryByRole("status", { name: "ตรวจยอด (Reconciliation)" }), status).toBeNull();
      for (const text of [SOLD_NO_UPLOAD, DEAD, UPLOADED, NO_POSTBACK]) expect(screen.queryByText(text), `${status} ${text}`).toBeNull();
      view.unmount();
    }
  });

  it("renders two same-type postbacks with the same timestamp as two rows", async () => {
    const lead = ownerLead();
    lead.postbacks = [lead.postbacks[0]!, { ...lead.postbacks[0]! }];
    respondWith(lead);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await renderScreen();
    expect(within(screen.getByLabelText("รายการผลจากผู้ซื้อ")).getAllByRole("row")).toHaveLength(3);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
    errors.mockRestore();
  });

  it("puts last_error behind a details element for an owner and omits it for an employee", async () => {
    const first = await renderScreen();
    const details = first.container.querySelector("details")!;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain("transient: upload endpoint answered 503");
    // Collapsed by default: the error text is not in the open flow.
    expect(details.hasAttribute("open")).toBe(false);
    expect(first.container.textContent!.split("transient: upload endpoint answered 503")).toHaveLength(2);
    first.unmount();

    respondWith(employeeLead());
    const second = await renderScreen(employee);
    expect(second.container.querySelector("details")).toBeNull();
    expect(second.container.textContent).not.toContain("transient");
    expect(screen.queryByText(/last_error|ข้อผิดพลาดล่าสุด/)).toBeNull();
  });

  it("shows no last_error row to an employee even when the data carries one", async () => {
    const lead = employeeLead();
    lead.conversion = { ...lead.conversion!, last_error: "transient: upload endpoint answered 503" };
    respondWith(lead);
    const { container } = await renderScreen(employee);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("transient");
    expect(screen.queryByText(/last_error|ข้อผิดพลาดล่าสุด|Last error/)).toBeNull();
  });

  it("renders null work_phone, keyword and updated_at as empty cells", async () => {
    const lead = ownerLead();
    lead.applicant!.work_phone = null;
    lead.keyword = null;
    lead.variant = null;
    lead.experiment_id = null;
    lead.updated_at = null;
    lead.conversion!.next_attempt_at = null;
    respondWith(lead);
    const { container } = await renderScreen();
    expect(rowOf("เบอร์ที่ทำงาน (Work phone)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(rowOf("คีย์เวิร์ด (Keyword)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(rowOf("ตัวแปร (Variant)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(rowOf("การทดลอง (Experiment)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(rowOf("อัปเดตเมื่อ (Updated)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(rowOf("ลองครั้งถัดไป (Next attempt)").getAllByRole("cell")[0]!.textContent).toBe("");
    expect(container.textContent).not.toContain("null");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("renders NotFound when the lead does not exist", async () => {
    answer = { status: 404, body: { error: "not_found" } };
    render(<LeadDetailScreen me={owner} leadId={LEAD_ID} onBack={() => {}} />);
    expect(await screen.findByText("ไม่พบลีดนี้")).toBeTruthy();
    expect(screen.getByText("กลับหน้าแรก (Back to Home)")).toBeTruthy();
    expect(screen.queryByText("ผลจากผู้ซื้อ")).toBeNull();
  });
});

describe("Lead detail timeline and panel", () => {
  it("lists the form, each postback and the upload in time order with the click id chip", async () => {
    await renderScreen();
    const items = within(screen.getByRole("list", { name: "ไทม์ไลน์ลีด" })).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent);
    expect(items).toEqual(["ส่งฟอร์ม", "ผลจากผู้ซื้อ: ลีดใหม่", "ผลจากผู้ซื้อ: ขายได้", "สร้างรายการอัปโหลด", "อัปโหลดสำเร็จ"]);
    expect(screen.getByText("มี click id (gclid)")).toBeTruthy();
  });

  it("shows a rejected lead as โดนปฏิเสธ with the no-reason line and never the word rejectLead", async () => {
    const lead = ownerLead();
    lead.outcome = "rejected";
    lead.status = "rejectLead";
    lead.postbacks = [{ event_type: "rejectLead", payout: 0, created_at: "2026-10-01T02:15:49.000Z" }];
    lead.conversion = null;
    respondWith(lead);
    const { container } = await renderScreen();
    expect(screen.getByRole("note", { name: "เหตุผลที่โดนปฏิเสธ" }).textContent).toBe("ผู้ซื้อไม่ได้ส่งเหตุผลมา");
    expect(within(screen.getByLabelText("รายการผลจากผู้ซื้อ")).getByText("โดนปฏิเสธ")).toBeTruthy();
    expect(rowOf("สถานะดิบ (Raw status)").getByText("โดนปฏิเสธ")).toBeTruthy();
    expect(container.textContent).not.toContain("rejectLead");
  });

  it("shows no reason line on a lead that was not rejected", async () => {
    await renderScreen();
    expect(screen.queryByRole("note", { name: "เหตุผลที่โดนปฏิเสธ" })).toBeNull();
    expect(screen.queryByText("ผู้ซื้อไม่ได้ส่งเหตุผลมา")).toBeNull();
  });

  it("shows a warning chip when the conversion carries no click id", async () => {
    const lead = ownerLead();
    lead.conversion = { ...lead.conversion!, click_type: "none" };
    respondWith(lead);
    await renderScreen();
    expect(screen.getByText("ไม่มี click id")).toBeTruthy();
  });

  it("renders as a panel with a level 2 heading and a close button that calls onBack", async () => {
    const onBack = vi.fn();
    const view = render(<LeadDetailScreen me={owner} leadId={LEAD_ID} onBack={onBack} panel />);
    await screen.findByText("ผลจากผู้ซื้อ");
    expect(screen.getByRole("heading", { level: 2, name: "รายละเอียดลีด" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(view.container.querySelector("aside.lead-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "ปิดรายละเอียด" }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
