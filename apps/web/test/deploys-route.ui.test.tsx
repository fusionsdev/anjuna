import { describe, expect, it } from "vitest";
import { pageTitle } from "../src/client/components/AppShell";
import { parseRoute, routePath, viewPath } from "../src/client/router";

describe("deploys route", () => {
  it("parses /deploys and round-trips through routePath", () => {
    expect(parseRoute("/deploys")).toEqual({ view: "deploys" });
    expect(routePath({ view: "deploys" })).toBe("/deploys");
    expect(viewPath("deploys")).toBe("/deploys");
  });

  it("keeps a trailing slash and an unknown sub-path out of the view", () => {
    expect(parseRoute("/deploys/")).toEqual({ view: "deploys" });
    expect(parseRoute("/deploys/inst-1")).toEqual({ view: "not-found", path: "/deploys/inst-1" });
  });

  it("has a page title", () => {
    expect(pageTitle.deploys).toBeTruthy();
  });
});
