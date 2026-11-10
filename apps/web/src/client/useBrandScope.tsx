import type { LifecycleBrandSummary } from "@anjuna/contracts";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { updatePrefs } from "./prefs-manager";
import { DEFAULT_SCOPE, type BrandScope, type ScopeBrand, type ScopeGroup, groupOfBrand, inScope, scopeFromPrefs, scopeFromSearch, scopeToPrefs, toScopeBrand } from "./brand-scope";

/** One brand as the scope popover lists it. */
export interface ScopeListEntry { brand: LifecycleBrandSummary; scope: ScopeBrand; group: ScopeGroup }

export interface BrandScopeState {
  scope: BrandScope;
  /** Applies a new scope at once and saves it for the user. A save that fails leaves the scope applied on this device. */
  setScope: (next: BrandScope) => void;
  /** Every brand the panel knows, or null until the list has loaded (or when it could not be read). */
  list: ScopeListEntry[] | null;
  visibleCount: number | null;
  totalCount: number | null;
  isVisible: (brand: ScopeBrand) => boolean;
  /** The popover. The subtitle chip's "แก้ไข" button opens it. */
  open: boolean;
  setOpen: (open: boolean) => void;
  /** True while a `?scope=` link decides the scope for this visit. */
  fromUrl: boolean;
  /** True when the last save of the scope failed or could not start. The scope still applies on this device. */
  saveFailed: boolean;
  /**
   * Whether a screen shows the rows of one brand. Before the brand list has loaded every brand shows, because nothing is known.
   * A brand the list does not hold follows the brand ticks only.
   */
  inScopeId: (brandId: string) => boolean;
  /** True once the list has loaded and the scope hides at least one brand. A screen that cannot filter an aggregate says so. */
  hidesBrands: boolean;
}

const Context = createContext<BrandScopeState | null>(null);

/** Outside the app shell a screen has no sidebar to change the scope, so it keeps the behaviour from before the scope existed: only demo brands are hidden. */
const STANDALONE_SCOPE: BrandScope = { hideInactive: false, showDemo: false, brandIds: null };

function useScopeState(persist: boolean): BrandScopeState {
  const urlScope = useRef(typeof window === "undefined" ? null : scopeFromSearch(window.location.search));
  const [scope, setScopeState] = useState<BrandScope>(urlScope.current ?? (persist ? DEFAULT_SCOPE : STANDALONE_SCOPE));
  const [fromUrl, setFromUrl] = useState(urlScope.current !== null);
  const [list, setList] = useState<ScopeListEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // null until GET /api/me/prefs has answered: a write before that would replace the saved views with an empty object.
  const savedViews = useRef<Record<string, unknown> | null>(null);
  const reading = useRef<Promise<boolean> | null>(null);
  const decidedByUser = useRef(false);
  const latest = useRef<BrandScope>(scope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const loadList = useCallback(async () => {
    const [lifecycle, runtime] = await Promise.allSettled([api.lifecycleBrands(), api.brands()]);
    if (lifecycle.status !== "fulfilled") return;
    const statuses = new Map(runtime.status === "fulfilled" ? runtime.value.brands.map((brand) => [brand.brand_id, brand.status as string]) : []);
    setList(lifecycle.value.brands.map((brand) => ({ brand, scope: toScopeBrand(brand, statuses.get(brand.brand_id)), group: groupOfBrand(brand, statuses.get(brand.brand_id)) })));
  }, []);

  /** Reads the saved prefs once at a time. True when they are known. A failed read can be tried again by the next write. */
  const readPrefs = useCallback((): Promise<boolean> => {
    if (savedViews.current !== null) return Promise.resolve(true);
    if (!reading.current) {
      reading.current = api.mePrefs().then((prefs) => {
        savedViews.current = prefs.saved_views;
        // A link's ?scope= and a choice made before the answer arrived both win over the saved scope.
        if (mounted.current && urlScope.current === null && !decidedByUser.current) { latest.current = scopeFromPrefs(prefs.brand_scope); setScopeState(latest.current); }
        return true;
      }, () => false).finally(() => { reading.current = null; });
    }
    return reading.current;
  }, []);

  useEffect(() => {
    if (!persist) return;
    void readPrefs();
    void loadList();
  }, [persist, readPrefs, loadList]);
  // The popover lists current brands, so opening it reads them again.
  useEffect(() => { if (persist && open) void loadList(); }, [persist, open, loadList]);

  const setScope = useCallback((next: BrandScope) => {
    decidedByUser.current = true;
    latest.current = next;
    setScopeState(next);
    if (urlScope.current !== null) {
      urlScope.current = null;
      setFromUrl(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("scope");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    if (!persist) return;
    // The prefs manager reads the saved prefs fresh, changes only brand_scope and writes in one queue shared with the other prefs writers
    // (the Realtime sound switch), so none of them can erase another's change. A failed read writes nothing and the user is told.
    void updatePrefs((cur) => ({ ...cur, brand_scope: scopeToPrefs(latest.current) })).then((saved) => {
      if (!mounted.current) return;
      if (saved === null) setSaveFailed(true);
      else if (latest.current === next) setSaveFailed(false);
    });
  }, [persist]);

  return useMemo(() => {
    const isVisible = (brand: ScopeBrand) => inScope(scope, brand);
    const visible = list ? list.filter((entry) => isVisible(entry.scope)).length : null;
    const byId = new Map((list ?? []).map((entry) => [entry.brand.brand_id, entry.scope] as const));
    const inScopeId = (brandId: string) => {
      if (list === null) return true;
      const known = byId.get(brandId);
      return known ? isVisible(known) : scope.brandIds === null || scope.brandIds.includes(brandId);
    };
    return { scope, setScope, list, visibleCount: visible, totalCount: list ? list.length : null, isVisible, open, setOpen, fromUrl, saveFailed, inScopeId, hidesBrands: list !== null && visible !== list.length };
  }, [scope, setScope, list, open, fromUrl, saveFailed]);
}

/** Holds the signed-in user's brand scope for the whole panel: saved through /api/me/prefs, overridden by `?scope=`. */
export function BrandScopeProvider({ children }: { children: ReactNode }) {
  const state = useScopeState(true);
  return <Context.Provider value={state}>{children}</Context.Provider>;
}

/** The brand scope. Outside a provider (a screen under test) it keeps the scope in local state and saves nothing. */
export function useBrandScope(): BrandScopeState {
  const provided = useContext(Context);
  const local = useScopeState(false);
  return provided ?? local;
}
