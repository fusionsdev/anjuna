import type { Source } from "./workspace.js";
import type { Issue } from "./types.js";

export interface CheckContext {
  source: Source;
  denyDomains: string[];
  denyIdentifiers: string[];
}

export type Check = (ctx: CheckContext) => Issue[];