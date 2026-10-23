import { useEffect, useState } from "react";

/** One screen of the panel and the id it shows, read from the URL path. */
export type Route =
  | { view: "home" }
  | { view: "brands"; brandId: string | null }
  | { view: "new-brand" }
  | { view: "templates"; templateId: string | null }
  | { view: "funnel" }
  | { view: "alerts" }
  | { view: "mailing" }
  | { view: "audit" }
  | { view: "users" }
  | { view: "builder-keys" }
  | { view: "not-found"; path: string };
export type View = Route["view"];

const STATIC: Record<string, Route> = {
  "/": { view: "home" },
  "/brands": { view: "brands", brandId: null },
  "/brands/new": { view: "new-brand" },
  "/templates": { view: "templates", templateId: null },
  "/funnel": { view: "funnel" },
  "/alerts": { view: "alerts" },
  "/mailing": { view: "mailing" },
  "/audit": { view: "audit" },
  "/users": { view: "users" },
  "/builder-keys": { view: "builder-keys" },
};

/** A bad escape such as "%" reads as no id, so the list opens. */
function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseRoute(pathname: string, hash = ""): Route {
  // template-mcp links to `/#templates/<id>`; keep those links working.
  const legacy = /^#templates(?:\/(.*))?$/.exec(hash);
  if (legacy) return { view: "templates", templateId: legacy[1] ? decode(legacy[1]) : null };
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const fixed = STATIC[path];
  if (fixed) return fixed;
  const one = /^\/(brands|templates)\/([^/]+)$/.exec(path);
  if (one) {
    const id = decode(one[2]!);
    return one[1] === "brands" ? { view: "brands", brandId: id } : { view: "templates", templateId: id };
  }
  return { view: "not-found", path };
}

export function routePath(route: Route): string {
  switch (route.view) {
    case "brands":
      return route.brandId ? `/brands/${encodeURIComponent(route.brandId)}` : "/brands";
    case "templates":
      return route.templateId ? `/templates/${encodeURIComponent(route.templateId)}` : "/templates";
    case "not-found":
      return route.path;
    default:
      return viewPath(route.view);
  }
}

export function viewPath(view: Exclude<View, "not-found">): string {
  switch (view) {
    case "home": return "/";
    case "new-brand": return "/brands/new";
    default: return `/${view}`;
  }
}

const ROUTE_EVENT = "anjuna:route";

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, "", path);
  else window.history.pushState(null, "", path);
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

function current(): Route {
  const route = parseRoute(window.location.pathname, window.location.hash);
  // Rewrite a legacy hash link to its path so reload and back keep the screen.
  if (window.location.hash.startsWith("#templates")) window.history.replaceState(null, "", routePath(route));
  return route;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current);
  useEffect(() => {
    const update = () => setRoute(current());
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    window.addEventListener(ROUTE_EVENT, update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      window.removeEventListener(ROUTE_EVENT, update);
    };
  }, []);
  return route;
}

/** A modified or middle click keeps the browser default: open the link in a new tab or window. */
export function isPlainLeftClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
