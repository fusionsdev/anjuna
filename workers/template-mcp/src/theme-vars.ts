/**
 * Theme variables of a submitted template (spec section 3):
 *   candidates: custom properties declared with a 3- or 6-digit hex value, minus
 *     gray/grey/slate/zinc/neutral/stone/white/black names
 *   primary: most var() uses inside background/background-color among candidates with
 *     WCAG contrast >= 3 against white (they carry white button text); ties to first declared
 *   primary_dark: declared <primary>-dark, else <primary>-hover
 *   secondary: most var() uses inside color, among the rest
 * One name or none per role; anything failing TemplateThemeVars becomes EMPTY_THEME_VARS.
 */
import { EMPTY_THEME_VARS, TemplateThemeVars, ThemeVarName } from "@anjuna/contracts";
import type { FileMap } from "./archive";
import { allElements, decode, parseHtml, rawText } from "./html";

const BANNED = ["gray", "grey", "slate", "zinc", "neutral", "stone", "white", "black"];
const DECL_RE = /(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+)/g;
const PROP_RE = /([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
const MIN_WHITE_CONTRAST = 3;
const VAR_RE = /var\(\s*(--[a-zA-Z0-9-]+)(?=[,\s)])/g;

/** The value is a lone 3- or 6-digit hex (trimmed, up to `;` or `}`, `!important` allowed); else null. */
function loneHex(value: string): string | null {
  const hex = value.replace(/\s*!\s*important\s*$/i, "").trim();
  return /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(hex) ? hex.slice(1) : null;
}

/** Every .css file plus the <style> elements of index.html, comments stripped. */
function cssTexts(files: FileMap): string[] {
  const texts: string[] = [];
  for (const [path, bytes] of files) {
    if (path.toLowerCase().endsWith(".css")) texts.push(decode(bytes));
  }
  const index = files.get("index.html");
  if (index) {
    for (const el of allElements(parseHtml(decode(index)))) {
      if (el.name === "style") texts.push(rawText(el));
    }
  }
  return texts.map((text) => text.replace(/\/\*.*?\*\//gs, ""));
}

/** WCAG 2.x contrast ratio of a 3- or 6-digit hex color against #ffffff. */
function whiteContrast(hex: string): number {
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}

/** The name with the most uses; none on ties with zero. Ties keep declaration order. */
function top(names: string[], uses: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const name of names) {
    const count = uses.get(name) ?? 0;
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

export function extractThemeVars(files: FileMap): TemplateThemeVars {
  const order: string[] = [];
  const seen = new Set<string>();
  const hexOf = new Map<string, string>();
  const bg = new Map<string, number>();
  const fg = new Map<string, number>();
  const texts = cssTexts(files);
  for (const css of texts) {
    for (const m of css.matchAll(DECL_RE)) {
      const hex = loneHex(m[2]!);
      if (!hex) continue;
      const name = m[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        hexOf.set(name, hex);
        order.push(name);
      }
    }
  }
  const candidates = order.filter(
    (name) => !BANNED.some((word) => name.toLowerCase().includes(word)) && ThemeVarName.safeParse(name).success,
  );
  const candSet = new Set(candidates);
  for (const css of texts) {
    for (const m of css.matchAll(PROP_RE)) {
      const prop = m[1]!.toLowerCase();
      if (prop !== "background" && prop !== "background-color" && prop !== "color") continue;
      const uses = prop === "color" ? fg : bg;
      for (const v of m[2]!.matchAll(VAR_RE)) {
        if (!candSet.has(v[1]!)) continue;
        uses.set(v[1]!, (uses.get(v[1]!) ?? 0) + 1);
      }
    }
  }
  const primary = top(
    candidates.filter((name) => whiteContrast(hexOf.get(name)!) >= MIN_WHITE_CONTRAST),
    bg,
  );
  if (!primary) return { ...EMPTY_THEME_VARS };
  const dark = [`${primary}-dark`, `${primary}-hover`].find((name) => candidates.includes(name));
  const secondary = top(
    candidates.filter((name) => name !== primary && name !== dark),
    fg,
  );
  const result: TemplateThemeVars = {
    primary: [primary],
    primary_dark: dark ? [dark] : [],
    secondary: secondary ? [secondary] : [],
  };
  return TemplateThemeVars.safeParse(result).success ? result : { ...EMPTY_THEME_VARS };
}
