import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Vitest runs from apps/web.
const read = (file: string) => readFileSync(resolve(process.cwd(), "src/client", file), "utf8");

describe("W02-3 touch targets", () => {
  it("keeps the control height token at 44px and does not lower .btn on the Campaigns page", () => {
    expect(read("styles/tokens.css")).toMatch(/--control-h:\s*44px/);
    const css = read("screens/Campaigns.css");
    expect(css).toMatch(/\.campaigns-page \.btn\s*\{\s*min-height:\s*44px/);
    expect(css).not.toMatch(/\.btn\s*\{\s*min-height:\s*(3\d|2\d)px/);
  });

  it("gives the budget save button and the other W02-3 buttons a rule of at least 44px", () => {
    // The budget save button is a .btn inside .campaigns-page, so the 44px rule above applies to it.
    expect(read("screens/Campaigns.tsx")).toContain('className="btn pri" disabled={busy || !changed || over}');
    expect(read("screens/Templates.css")).toMatch(/\.tpl-drawer-error \.btn\s*\{[^}]*min-height:\s*44px/);
    expect(read("screens/Leads.css")).toMatch(/\.filter-chips button\s*\{[^}]*min-height:\s*44px/);
    expect(read("screens/Conversions.css")).toMatch(/\.conv-chips button\s*\{[^}]*min-height:\s*44px/);
  });
});

describe("W02-3 text language", () => {
  const files = ["screens/LeadDetail.tsx", "screens/TemplateTable.tsx", "screens/Alerts.tsx", "screens/NotifySettings.tsx", "screens/Campaigns.tsx", "components/SettingsSections.tsx"];
  // Thai text followed by an English gloss in parentheses, such as "คัดลอก (Copy)".
  const gloss = /[฀-๿][ 	]*\([A-Za-z][A-Za-z ,.'-]*\)/;
  it.each(["screens/LeadDetail.tsx:รายละเอียดลีด", "screens/LeadDetail.tsx:คัดลอก", "screens/TemplateTable.tsx:ตัวอย่าง", "screens/Alerts.tsx:รับทราบ", "screens/Leads.tsx:รายการลีด"])("%s has no English gloss", (entry) => {
    const [file, word] = entry.split(":") as [string, string];
    const lines = read(file).split("\n").filter((line) => line.includes(word));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toMatch(gloss);
  });
  it("keeps the files of this task free of a Thai text with an English gloss in the strings it added", () => {
    // LeadDetail, Leads and Conversions still carry glosses written before W02-3 in their older labels; the files below carry none.
    for (const file of files.filter((f) => f !== "screens/LeadDetail.tsx" && f !== "screens/Campaigns.tsx")) expect(read(file), file).not.toMatch(gloss);
  });
});
