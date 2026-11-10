import type { AlertStateRow } from "@anjuna/contracts";
import { useSyncExternalStore } from "react";

/**
 * The alert states the Alerts screen shows. Core keeps every acknowledge and close; the screen reads them back with
 * `GET /api/alerts/state` each time it starts (hydrate), and a successful ack or close adds the row core returned at once (record).
 * The store sits above the screen so a tab switch or a new mount keeps them while the next read is in flight. It is keyed by
 * `<rule>:<brand>`, the key core stores states under. The server copy is the truth: nothing here is written to browser storage.
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

/** Merges the rows core returned. A row already held stays when it is newer than the one read. */
export function hydrateAlertStates(read: readonly AlertStateRow[]): void {
  const next = new Map(rows);
  for (const row of read) {
    const held = next.get(row.alert_key);
    if (!held || held.updated_at <= row.updated_at) next.set(row.alert_key, row);
  }
  rows = next;
  for (const listener of listeners) listener();
}

/** Forgets every state, for a new sign-in and for tests. */
export function resetAlertSession(): void {
  rows = new Map();
  for (const listener of listeners) listener();
}

export const useAlertSession = (): ReadonlyMap<string, AlertStateRow> => useSyncExternalStore(subscribe, () => rows);
