import type { FlowGateMode } from "@anjuna/contracts";

/** What the Owner reads for a flow gate mode; the stored values stay `param` and `signed_cookie`. */
export const flowGateLabel: Record<FlowGateMode, string> = { param: "Keyword Param", signed_cookie: "Single Page Cookie" };
