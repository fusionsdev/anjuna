import { describe, expect, it } from "vitest";
import { isLocalDev } from "../src/server/local-dev.js";
import { makeEnv } from "./helpers.js";

const req = (url: string, ip?: string) => new Request(url, { headers: ip ? { "CF-Connecting-IP": ip } : {} });

describe("isLocalDev", () => {
  it.each([
    ["1", "https://app.maimax.com/api/me", "203.0.113.8", false],
    ["1", "https://app.aduplift.ai/api/me", "203.0.113.8", false],
    ["1", "https://app.maimax.com/api/me", undefined, false],
    ["1", "https://app.aduplift.ai/api/me", undefined, true],
    ["1", "https://app.aduplift.ai/api/me", "127.0.0.1", true],
    ["1", "http://localhost:8787/api/me", "::1", true],
    [undefined, "http://127.0.0.1:8787/api/me", undefined, false],
    ["0", "http://localhost:8787/api/me", undefined, false],
    ["1", "http://127.0.0.1:8787/api/me", undefined, true],
    ["1", "http://[::1]:8787/api/me", "::1", true],
    ["1", "http://panel.localhost:8787/api/me", "::ffff:127.0.0.1", true],
    ["1", "http://localhost:8787/api/me", "203.0.113.8", false],
    ["1", "http://localhost.example/api/me", undefined, false],
  ])("flag=%s url=%s ip=%s → %s", (flag, url, ip, want) => {
    const env = makeEnv({ DEV_ACCESS_BYPASS: flag, BETTER_AUTH_URL: "https://app.aduplift.ai" });
    expect(isLocalDev(req(url, ip), env)).toBe(want);
  });
});
