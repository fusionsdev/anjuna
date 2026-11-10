import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOUND_VIEW_KEY, updatePrefs } from "../src/client/prefs-manager";

type Prefs = { brand_scope: { hide_inactive: boolean; show_demo: boolean; brand_ids: string[] | null }; saved_views: Record<string, unknown> };
let server: Prefs;
let log: string[];
let readStatus: number;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  server = { brand_scope: { hide_inactive: true, show_demo: false, brand_ids: null }, saved_views: { traffic: { period: "7d" } } };
  log = [];
  readStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input !== "/api/me/prefs") throw new Error(`Unexpected test HTTP request: ${input}`);
    if (init?.method === "PUT") {
      await pause(15);
      server = JSON.parse(String(init.body));
      log.push("PUT");
      return json(server);
    }
    log.push("GET");
    await pause(5);
    return readStatus === 200 ? json(server) : json({ error: "down" }, readStatus);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("prefs manager", () => {
  it("runs a scope change and the sound switch started together one after the other, so neither erases the other", async () => {
    const [scope, sound] = await Promise.all([
      updatePrefs((cur) => ({ ...cur, brand_scope: { hide_inactive: false, show_demo: true, brand_ids: ["brand-a"] } })),
      updatePrefs((cur) => ({ ...cur, saved_views: { ...cur.saved_views, [SOUND_VIEW_KEY]: true } })),
    ]);
    expect(scope).not.toBeNull();
    expect(sound).not.toBeNull();
    // Each write read the server first, after the write before it had landed.
    expect(log).toEqual(["GET", "PUT", "GET", "PUT"]);
    expect(server).toEqual({
      brand_scope: { hide_inactive: false, show_demo: true, brand_ids: ["brand-a"] },
      saved_views: { traffic: { period: "7d" }, [SOUND_VIEW_KEY]: true },
    });
  });

  it("writes nothing when the read fails, and the next write still runs", async () => {
    readStatus = 502;
    expect(await updatePrefs((cur) => ({ ...cur, saved_views: {} }))).toBeNull();
    expect(log).toEqual(["GET"]);
    expect(server.saved_views).toEqual({ traffic: { period: "7d" } });
    readStatus = 200;
    expect(await updatePrefs((cur) => ({ ...cur, saved_views: { ...cur.saved_views, [SOUND_VIEW_KEY]: false } }))).not.toBeNull();
    expect(server.saved_views).toEqual({ traffic: { period: "7d" }, [SOUND_VIEW_KEY]: false });
  });
});
