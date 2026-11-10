import { api, type UserPrefsBody } from "./api";

/**
 * The one writer of `PUT /api/me/prefs`. The endpoint stores brand_scope and saved_views from one body, so a writer that sends a copy
 * it read earlier can erase a change another writer made in between. Every write here runs in one queue, reads the prefs fresh from the server
 * when its turn comes, changes only its own part and sends the whole body back. Two quick writes (a scope change and the sound switch)
 * can therefore never overwrite each other. A read that fails writes nothing.
 */
let queue: Promise<unknown> = Promise.resolve();

/** Reads the saved prefs. Null when the read fails. */
export const readPrefs = (): Promise<UserPrefsBody | null> => api.mePrefs().then((prefs) => prefs, () => null);

/**
 * Applies `change` to the prefs the server holds now and saves the result. Resolves to the saved prefs, or to null when the read or the write failed
 * (nothing is written after a failed read).
 */
export function updatePrefs(change: (current: UserPrefsBody) => UserPrefsBody): Promise<UserPrefsBody | null> {
  const run = async (): Promise<UserPrefsBody | null> => {
    const current = await readPrefs();
    if (!current) return null;
    try {
      return await api.saveMePrefs(change(current));
    } catch {
      return null;
    }
  };
  const result = queue.then(run, run);
  queue = result;
  return result;
}

/** The key under `saved_views` that holds the Realtime page's AdsBot sound switch. */
export const SOUND_VIEW_KEY = "realtime_sound";
