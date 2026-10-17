import { afterEach, describe, expect, it, vi } from "vitest";
import { measurePayload, probePublishedUrl, visibleBodyText } from "../src/probe";

afterEach(() => vi.unstubAllGlobals());

/** Hosts keyed by "host/path"; anything else answers like bolt.host did: 404 "Website not found". */
function host(routes: Record<string, () => Response>) {
  vi.stubGlobal("fetch", async (input: string) => {
    const url = new URL(String(input));
    const route = routes[url.host + url.pathname];
    return route ? route() : new Response("Website not found", { status: 404, headers: { "content-type": "text/html" } });
  });
}

describe("spike probes", () => {
  it("measures a tool argument in characters and UTF-8 bytes", () => {
    expect(measurePayload("x".repeat(20_000))).toEqual({ received_chars: 20_000, received_bytes: 20_000 });
    expect(measurePayload("ก")).toEqual({ received_chars: 1, received_bytes: 3 });
  });

  it("follows redirects to a static page and reports its visible text", async () => {
    host({
      "willow.bolt.host/": () => new Response(null, { status: 301, headers: { location: "https://willow-lake.bolt.host/" } }),
      "willow-lake.bolt.host/": () => new Response("<html><body><h1>Willow Lake Lending</h1></body></html>", { headers: { "content-type": "text/html" } }),
    });
    const probe = await probePublishedUrl("https://willow.bolt.host/");
    expect(probe.hops.map((hop) => hop.status)).toEqual([301, 200]);
    expect(probe).toMatchObject({ final_url: "https://willow-lake.bolt.host/", status: 200, ok: true, client_rendered: false });
    expect(probe.visible_text_chars).toBe("Willow Lake Lending".length);
    expect(probe.visible_text).toBe("Willow Lake Lending");
  });

  it("reports a missing site and a client-rendered shell", async () => {
    host({ "spa.bolt.host/": () => new Response('<html><body><div id="root"></div><script src="/a.js"></script></body></html>', { headers: { "content-type": "text/html" } }) });
    expect(await probePublishedUrl("https://gone.bolt.host/")).toMatchObject({ status: 404, ok: false });
    expect(await probePublishedUrl("https://spa.bolt.host/")).toMatchObject({ status: 200, ok: false, client_rendered: true });
    expect(visibleBodyText('<body><noscript>Enable JS</noscript><div id="root"></div></body>')).toBe("");
  });

  it("stops reading at 2 MB and previews 500 visible characters", async () => {
    const page = "<html><body><p>" + "a".repeat(3 * 1024 * 1024) + "</p></body></html>";
    host({ "big.bolt.host/": () => new Response(page, { headers: { "content-type": "text/html" } }) });
    const probe = await probePublishedUrl("https://big.bolt.host/");
    expect(probe.html_bytes).toBe(2 * 1024 * 1024);
    expect(probe.visible_text).toHaveLength(500);
  });
});
