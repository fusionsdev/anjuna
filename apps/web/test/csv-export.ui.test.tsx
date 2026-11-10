import conversionsFixture from "@anjuna/contracts/fixtures/admin/conversions.response.json";
import type { ConversionsReportResponse } from "@anjuna/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../src/client/api";
import { CsvButton } from "../src/client/components/CsvButton";
import { CSV_BOM, csvField, csvFileName, toCsv } from "../src/client/csv";
import { ConversionsScreen } from "../src/client/screens/Conversions";

const report = conversionsFixture as ConversionsReportResponse;
const owner: Me = { id: "owner", email: "owner@example.test", role: "owner" };
const employee: Me = { id: "employee", email: "employee@example.test", role: "employee" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

let saved: Array<{ name: string; blob: Blob }>;
/** The bytes of a saved blob (read as bytes so the BOM stays visible) and the text with the BOM kept. */
const readBlob = (blob: Blob) => new Promise<{ bytes: number[]; text: string }>((resolve) => {
  const reader = new FileReader();
  reader.onload = () => {
    const bytes = Array.from(new Uint8Array(reader.result as ArrayBuffer));
    resolve({ bytes, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(bytes)) });
  };
  reader.readAsArrayBuffer(blob);
});

beforeEach(() => {
  saved = [];
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => { saved.push({ name: "", blob }); return "blob:csv"; }),
    revokeObjectURL: vi.fn(),
  });
  // jsdom does not navigate on an anchor click; the click only records the file name from the download attribute.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.at(-1)!.name = this.download; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/"); });

describe("csv helper", () => {
  it("starts the file with a UTF-8 BOM so Thai opens in Excel", () => {
    const text = toCsv([{ header: "ชื่อ", value: (r: { n: string }) => r.n }], [{ n: "สมชาย" }]);
    expect(text.startsWith(CSV_BOM)).toBe(true);
    expect(text).toBe(`${CSV_BOM}ชื่อ\r\nสมชาย\r\n`);
  });

  it("quotes a field with a comma, a quote, a line break or an outer space, and doubles the quotes", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(" padded")).toBe('" padded"');
    expect(csvField("plain")).toBe("plain");
  });

  it("writes numbers as they are, empty for null and undefined, and keeps a leading minus on a number", () => {
    expect(csvField(1234.5)).toBe("1234.5");
    expect(csvField(-3)).toBe("-3");
    expect(csvField("-3.5")).toBe("-3.5");
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("marks a text that a spreadsheet would run as a formula", () => {
    expect(csvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvField("+1 call")).toBe("'+1 call");
    expect(csvField("@cmd")).toBe("'@cmd");
  });

  it("writes only the columns it is given, in order", () => {
    const text = toCsv([{ header: "a", value: (r: { a: number; secret: number }) => r.a }], [{ a: 1, secret: 99 }]);
    expect(text).not.toContain("99");
    expect(text).toBe(`${CSV_BOM}a\r\n1\r\n`);
  });

  it("names the file after the page and the date", () => {
    expect(csvFileName("leads", new Date("2026-11-10T23:30:00.000Z"))).toBe("leads-2026-11-10.csv");
  });
});

describe("CsvButton", () => {
  it("saves the rows as a UTF-8 file with the BOM bytes, the heading row and the page and date in the name", async () => {
    render(<CsvButton page="demo" columns={[{ header: "ชื่อ", value: (r: { n: string }) => r.n }]} rows={[{ n: "สมชาย, ใจดี" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "ส่งออก CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const { bytes, text } = await readBlob(saved[0]!.blob);
    expect(bytes.slice(0, 3)).toEqual([0xef, 0xbb, 0xbf]);
    expect(text).toBe(`${CSV_BOM}ชื่อ\r\n"สมชาย, ใจดี"\r\n`);
    expect(saved[0]!.name).toMatch(/^demo-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("is off while there are no rows", () => {
    render(<CsvButton page="demo" columns={[{ header: "a", value: () => "x" }]} rows={[]} />);
    expect((screen.getByRole("button", { name: "ส่งออก CSV" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Conversions CSV follows the role", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/conversions");
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname === "/api/conversions") return json(report);
      if (url.pathname === "/api/lifecycle/brands") return json({ brands: [{ brand_id: "brand-a", hostnames: ["a.example"] }] });
      if (url.pathname === "/api/brands") return json({ brands: [], generated_at: "2026-10-23T00:00:00.000Z" });
      throw new Error(`Unexpected test HTTP request: ${input}`);
    }));
  });

  const exportAs = async (me: Me) => {
    render(<ConversionsScreen me={me} />);
    await screen.findByRole("table", { name: "รายการคอนเวอร์ชัน (Conversions)" });
    fireEvent.click(screen.getByRole("button", { name: "ส่งออก CSV" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    return readBlob(saved[0]!.blob);
  };

  it("gives an owner the value column and one line per row on screen", async () => {
    const { text } = await exportAs(owner);
    const [head, ...lines] = text.replace(CSV_BOM, "").trimEnd().split("\r\n");
    expect(head).toContain("มูลค่า");
    expect(head).toContain("แบรนด์");
    expect(lines.length).toBeGreaterThanOrEqual(report.rows.length);
  });

  it("gives an employee a file with no value column", async () => {
    const { text } = await exportAs(employee);
    expect(text.split("\r\n")[0]).not.toContain("มูลค่า");
  });
});
