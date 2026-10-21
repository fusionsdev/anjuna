import { describe, expect, it } from "vitest";
import { TEMPLATE_ZIP_FORM_MAX_BYTES, TEMPLATE_ZIP_LIMITS } from "@anjuna/contracts";
import { readZipForm } from "../src/zip-form";

describe("bounded ZIP multipart", () => {
  it("reads a multipart file and fields", async () => {
    const form = new FormData();
    form.set("file", new Blob(["zip bytes"]), "site.zip");
    form.set("template_id", "harbor");
    const parsed = await readZipForm(new Request("https://panel.test", { method: "POST", body: form }));
    expect(parsed.get("template_id")).toBe("harbor");
    expect((parsed.get("file") as Blob).size).toBe(9);
  });

  it("rejects non-multipart, missing file and declared oversized bodies", async () => {
    await expect(readZipForm(new Request("https://panel.test", { method: "POST", body: "x" }))).rejects.toThrow("multipart");
    await expect(readZipForm(new Request("https://panel.test", { method: "POST", body: new FormData() }))).rejects.toThrow("ZIP file is required");
    await expect(readZipForm(new Request("https://panel.test", {
      method: "POST", body: "x", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(TEMPLATE_ZIP_LIMITS.maxArchiveBytes + 20_000) },
    }))).rejects.toThrow("30 MB");
  });

  it("caps requests without Content-Length before parsing multipart", async () => {
    const bytes = new Uint8Array(TEMPLATE_ZIP_FORM_MAX_BYTES + 1);
    await expect(readZipForm(new Request("https://panel.test", {
      method: "POST", body: bytes, headers: { "content-type": "multipart/form-data; boundary=x" },
    }))).rejects.toThrow("30 MB");
  });
});
