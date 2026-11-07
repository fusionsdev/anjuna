import type { MouseEvent } from "react";
import { isPlainLeftClick, navigate } from "../../router";

/** A number, `null` for data that could not be read (shown as "—"), `undefined` while it loads (shown as "…"). */
export type Value = number | null | undefined;

export const mark = (value: Value): string | null => (value === undefined ? "…" : value === null ? "—" : null);
export const num = (value: Value): string => mark(value) ?? Math.round(value as number).toLocaleString("en-US");

/** A plain left click moves inside the app; a ctrl-click or middle-click keeps the browser default (a new tab). */
export const inApp = (path: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (!isPlainLeftClick(event)) return;
  event.preventDefault();
  navigate(path);
};
