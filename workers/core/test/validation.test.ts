import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateLeadPayload } from "../src/rpc/validation.js";
import { consentText } from "../src/rpc/consent.js";
import { validationEnv } from "../src/rpc/submit.js";
import type { Env } from "../src/env.js";
import * as V1 from "../../../packages/contracts/test/v1/validate-lead.v1.js";
import { fixtureText, ROOT } from "./helpers.js";

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-02T15:04:05Z")); });
afterAll(() => vi.useRealTimers());
const env = validationEnv({} as Env);

describe.each(["lite", "full"])("%s validation against the pinned V1 validator", (variant) => {
  it("matches the golden normalized value, including empty lite fields", () => {
    const input = JSON.parse(fixtureText(`form/lead.${variant}_v1.json`)); input.site.site_id = "form-default";
    expect(validateLeadPayload(input, env)).toEqual(V1.validateLeadPayload(input, env));
    expect(validateLeadPayload(input, env).ok).toBe(true);
  });
  it.each([
    ["first_name", "X"], ["last_name", "Sm1th"], ["email", "x@"], ["home_phone", "123"], ["work_phone", "123"],
    ["requested_amount", "99"], ["requested_amount", "5001"], ["loan_purpose", "garbage"],
    ["birth_date", "2015-01-01"], ["address", "x"], ["city", "x"], ["state", "PR"], ["zip", "1234"],
    ["address_length_months", "0"], ["own_home", "2"], ["income_type", "garbage"], ["employer", "x"],
    ["job_title", "x"], ["employed_months", "61"], ["pay_date1", "2020-01-01"], ["pay_date1", "2030-01-01"],
    ["pay_frequency", "garbage"], ["direct_deposit", "2"], ["monthly_income", "1125"], ["monthly_income", "6001"],
  ])("matches V1 rejecting %s=%s", (key, value) => {
    const input = JSON.parse(fixtureText(`form/lead.${variant}_v1.json`)); input.site.site_id = "form-default";
    input.lead[key!] = value;
    const actual = validateLeadPayload(input, env);
    expect(actual).toEqual(V1.validateLeadPayload(input, env));
    expect(actual.ok).toBe(false);
  });
});

it("consent text matches the actual form paragraphs whose version is recorded", () => {
  const source = readFileSync(join(ROOT, "apps/lead-form/src/App.tsx"), "utf8");
  const paragraphs = ["consentText", "tcpaConsentText"].map((name) => {
    const template = new RegExp(`${name}: \\(brand: string\\) =>\\s*\x60([^\x60]+)\x60`).exec(source)?.[1];
    expect(template).toBeDefined();
    return template!.replaceAll("${brand}", "Brand A");
  });
  expect(consentText("Brand A")).toBe(paragraphs.join("\n"));
});
