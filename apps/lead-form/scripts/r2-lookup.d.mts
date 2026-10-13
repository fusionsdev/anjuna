export const NOT_FOUND_TEXT: string;
export type LookupVerdict = "missing" | "same" | "different" | "error";
export function classifyLookup(input: { exitCode: number; output: string; existing?: Uint8Array; local?: Uint8Array }): LookupVerdict;
