// Runtime config injected by the brand Worker into <script type="application/json" id="cfg">.
// The same values the server used for HTML rewriting, so client render matches server intent.
export interface RuntimeConfig {
  amount?: number;
  zip?: string;
  keyword?: string | null;
  formRoute?: string;
  brand?: string;
}

function read(): RuntimeConfig {
  if (typeof document === "undefined") return {};
  try {
    return JSON.parse(document.getElementById("cfg")?.textContent || "{}") as RuntimeConfig;
  } catch {
    return {};
  }
}

export const RUNTIME_CONFIG: RuntimeConfig = read();
