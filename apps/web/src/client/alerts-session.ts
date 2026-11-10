import type { AlertStateRow } from "@anjuna/contracts";
import { useSyncExternalStore } from "react";

/**
 * The alert states this browser session changed. Core keeps every acknowledge and close, but no call lists the stored states,
 * so a reload shows the report again. This store sits above the Alerts screen: leaving the page, opening the history tab or
 * mounting the screen again keeps what the owner already did. It is keyed by `<rule>:<brand>`, the key core stores states under.
 */
let rows: ReadonlyMap<string, AlertStateRow> = new Map();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Keeps the row core returned after a successful acknowledge or close. */
export function recordAlertState(row: AlertStateRow): void {
  rows = new Map(rows).set(row.alert_key, row);
  for (const listener of listeners) listener();
}

/** Forgets every state, for a new sign-in and for tests. */
export function resetAlertSession(): void {
  rows = new Map();
  for (const listener of listeners) listener();
}

export const useAlertSession = (): ReadonlyMap<string, AlertStateRow> => useSyncExternalStore(subscribe, () => rows);
