export type TerminalMode = "read" | "draft" | "publish";
export const ALLOWED_COMMANDS: readonly string[];
export const PROJECT_ARG: RegExp;
export const TERMINAL_MODES: readonly TerminalMode[];
export const TERMINAL_LINE_MAX: number;
export const TERMINAL_OUTPUT_MAX: number;
export class CommandNotAllowedError extends Error {}
export function assertAllowed(args: unknown, kind?: string): void;
export function assertProject(project: unknown): void;
export function terminalKind(argv: unknown): string;
export function checkTerminalArgv(argv: unknown, mode: unknown): { ok: true } | { ok: false; reason: string };
export function parseTerminalLine(line: unknown, mode: unknown): { ok: true; argv: string[]; mode: TerminalMode } | { ok: false; reason: string };
export function redactTerminalOutput(text: unknown): string;
