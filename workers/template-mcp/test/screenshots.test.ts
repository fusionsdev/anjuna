import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HTTPRequest, ResponseForRequest } from "@cloudflare/puppeteer";
import puppeteer from "@cloudflare/puppeteer";
import { takeScreenshot } from "../src/screenshots";
import { goodSite, withFile } from "./fixtures";

vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));

const binding = {} as Fetcher;
const png = new Uint8Array([137, 80, 78, 71]);
let onRequest: (request: HTTPRequest) => void;
let urls: string[];
let responses: Map<string, Partial<ResponseForRequest>>;
let aborted: string[];
const close = vi.fn();
const screenshot = vi.fn();
const viewport = vi.fn();

beforeEach(() => {
  urls = ["https://template.invalid/", "https://template.invalid/assets/site.css", "https://template.invalid/assets/logo.svg?cache=1"];
  responses = new Map();
  aborted = [];
  close.mockReset().mockResolvedValue(undefined);
  screenshot.mockReset().mockResolvedValue(png);
  viewport.mockReset().mockResolvedValue(undefined);
  const page = {
    setViewport: viewport,
    setRequestInterception: vi.fn(),
    on: vi.fn((_event: string, handler: typeof onRequest) => { onRequest = handler; }),
    goto: vi.fn(async () => {
      for (const url of urls) {
        await new Promise<void>((resolve) => {
          onRequest({
            url: () => url,
            respond: async (response: Partial<ResponseForRequest>) => { responses.set(url, response); resolve(); },
            abort: async () => { aborted.push(url); resolve(); },
            continue: async () => { resolve(); },
            isInterceptResolutionHandled: () => false,
          } as unknown as HTTPRequest);
        });
      }
    }),
    evaluate: vi.fn(),
    screenshot,
  };
  vi.mocked(puppeteer.launch).mockReset().mockResolvedValue({ newPage: async () => page, close } as unknown as Awaited<ReturnType<typeof puppeteer.launch>>);
});

const files = () => withFile(goodSite(), "assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>');

describe("archive screenshots with bound browser", () => {
  it.each([[1280, 800], [390, 844]])("serves HTML, CSS and image bytes at %i x %i", async (width, height) => {
    const archive = files();
    expect(await takeScreenshot(binding, archive, width, height)).toEqual(png);
    expect(puppeteer.launch).toHaveBeenCalledWith(binding);
    expect(viewport).toHaveBeenCalledWith({ width, height });
    for (const [url, key, contentType] of [
      [urls[0]!, "index.html", "text/html"],
      [urls[1]!, "assets/site.css", "text/css"],
      [urls[2]!, "assets/logo.svg", "image/svg+xml"],
    ]) {
      expect(responses.get(url!)).toMatchObject({ status: 200, contentType, body: archive.get(key!) });
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("fails evidence if a referenced archive asset is missing", async () => {
    await expect(takeScreenshot(binding, goodSite(), 1280, 800)).rejects.toThrow("Missing archive asset assets/logo.svg");
    expect(screenshot).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("blocks external requests and rejects incomplete rendering", async () => {
    urls.push("https://external.example/image.png");
    await expect(takeScreenshot(binding, files(), 390, 844)).rejects.toThrow("include assets in the ZIP");
    expect(aborted).toEqual(["https://external.example/image.png"]);
    expect(screenshot).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes browser on screenshot failure", async () => {
    screenshot.mockRejectedValueOnce(new Error("capture failed"));
    await expect(takeScreenshot(binding, files(), 390, 844)).rejects.toThrow("capture failed");
    expect(close).toHaveBeenCalledOnce();
  });
});
