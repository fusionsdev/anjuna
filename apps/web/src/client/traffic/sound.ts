import { useCallback, useEffect, useRef, useState } from "react";
import { SOUND_VIEW_KEY, readPrefs, updatePrefs } from "../prefs-manager";

type AudioContextCtor = typeof AudioContext;
const contextClass = (): AudioContextCtor | undefined =>
  typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;

/**
 * The AdsBot beep and its on/off switch. The switch is saved with the user's prefs (`saved_views.realtime_sound` in `/api/me/prefs`),
 * so it follows the user to another device. The save goes through the prefs manager, which keeps the brand scope and the other saved views intact.
 * It starts off and turns on when the saved value is read, unless the user already clicked. A failed read or save leaves it as the user set it on this page and reports `saveFailed`.
 * Nothing is played, and no AudioContext is made, while the switch is off. Turning it on is a click, which browsers need before they allow sound.
 */
export function useAdsbotSound(): { enabled: boolean; setEnabled: (on: boolean) => void; beep: () => void; saveFailed: boolean } {
  const [enabled, setEnabledState] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const touched = useRef(false);
  const mounted = useRef(true);
  const enabledRef = useRef(enabled);
  const contextRef = useRef<AudioContext | null>(null);
  enabledRef.current = enabled;
  useEffect(() => {
    mounted.current = true;
    void readPrefs().then((prefs) => {
      // A click made before the answer arrived wins over the saved value.
      if (!mounted.current || touched.current || !prefs) return;
      const saved = prefs.saved_views[SOUND_VIEW_KEY] === true;
      enabledRef.current = saved;
      setEnabledState(saved);
    });
    return () => { mounted.current = false; };
  }, []);

  const context = useCallback((): AudioContext | null => {
    if (contextRef.current) return contextRef.current;
    const Ctor = contextClass();
    if (!Ctor) return null;
    try {
      contextRef.current = new Ctor();
    } catch {
      return null;
    }
    return contextRef.current;
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    enabledRef.current = on;
    setEnabledState(on);
    touched.current = true;
    void updatePrefs((cur) => ({ ...cur, saved_views: { ...cur.saved_views, [SOUND_VIEW_KEY]: on } })).then((saved) => {
      if (mounted.current) setSaveFailed(saved === null);
    });
    if (on) void context()?.resume?.();
  }, [context]);

  const beep = useCallback(() => {
    if (!enabledRef.current) return;
    const ctx = context();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* a blocked or closed context stays silent */ }
  }, [context]);

  useEffect(() => () => { void contextRef.current?.close?.(); contextRef.current = null; }, []);
  return { enabled, setEnabled, beep, saveFailed };
}
