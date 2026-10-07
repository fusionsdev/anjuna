import { describe, expect, it } from "vitest";
import entry from "../src/entry.js";
import { setup } from "./helpers.js";

function fixture() {
  const { core: _core, assets, ...settings } = setup().config;
  const core = { fetch: async () => Response.json({ error: "not used" }, { status: 503 }) };
  return { ASSETS: assets, CORE: core, CORE_TOKEN: "t", BRAND_CONFIG: settings };
}

describe("factory entry", () => {
  it("accepts BRAND_CONFIG as the object a json binding provides", async () => {
    const res = await entry.fetch(new Request("https://brand-a.example/unknown"), fixture());
    expect(res.status).toBe(404);
  });

  it("still accepts BRAND_CONFIG as a JSON string", async () => {
    const env = fixture();
    const res = await entry.fetch(new Request("https://brand-a.example/unknown"), {
      ...env, BRAND_CONFIG: JSON.stringify(env.BRAND_CONFIG),
    });
    expect(res.status).toBe(404);
  });
});
