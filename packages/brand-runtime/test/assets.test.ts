import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("real asset binding serves rewritten landing and form; internal HTML stays gated", async () => {
  const landing = await SELF.fetch("https://example.com/?keyword=quick+cash");
  expect(landing.status).toBe(200);
  // The H1 slot holds the brand name; the ad keyword is not shown.
  const body = await landing.text();
  expect(body).toContain("<span data-kw>Example Brand</span>");
  expect(body).not.toContain("Quick Cash");
  const form = await SELF.fetch("https://example.com/request?requested_amount=750&zip=60601");
  expect(form.status).toBe(200);
  expect(await form.text()).toContain('"amount":750');
  for (const path of ["/index.html", "/_f/index.html", "/unknown", "/_f/assets/missing.js"]) {
    const response = await SELF.fetch(`https://example.com${path}`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found");
  }
});

it("the static allowlist can serve published assets through the real binding", async () => {
  const response = await SELF.fetch("https://example.com/_f/assets/example.js");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("Example asset");
});
