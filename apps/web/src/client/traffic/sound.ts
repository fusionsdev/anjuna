import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "anjuna.traffic.sound";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
function write(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch { /* the switch still works for this visit */ }
}

type AudioContextCtor = typeof AudioContext;
const contextClass = (): AudioContextCtor | undefined =>
  typeof window === "undefined" ? undefined : window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;

/**
 * The AdsBot beep and its on/off switch. The switch is kept on this device (localStorage): the user prefs API stores the brand scope
 * and saved views as one document, and a save from here could overwrite a scope change made at the same time.
 * Nothing is played, and no AudioContext is made, while the switch is off. Turning it on is a click, which browsers need before they allow sound.
 */
export function useAdsbotSound(): { enabled: boolean; setEnabled: (on: boolean) => void; beep: () => void } {
  const [enabled, setEnabledState] = useState(read);
  const enabledRef = useRef(enabled);
  const contextRef = useRef<AudioContext | null>(null);
  enabledRef.current = enabled;

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
    write(on);
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
  return { enabled, setEnabled, beep };
}
