import type { LifecycleBrandSummary } from "@anjuna/contracts";
import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
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
  const savedViews = useRef<Record<string, unknown>>({});
  const decidedByUser = useRef(false);

  const loadList = useCallback(async () => {
    const [lifecycle, runtime] = await Promise.allSettled([api.lifecycleBrands(), api.brands()]);
    if (lifecycle.status !== "fulfilled") return;
    const statuses = new Map(runtime.status === "fulfilled" ? runtime.value.brands.map((brand) => [brand.brand_id, brand.status as string]) : []);
    setList(lifecycle.value.brands.map((brand) => ({ brand, scope: toScopeBrand(brand, statuses.get(brand.brand_id)), group: groupOfBrand(brand, statuses.get(brand.brand_id)) })));
  }, []);

  useEffect(() => {
    if (!persist) return;
    let active = true;
    void api.mePrefs().then((prefs) => {
      if (!active) return;
      savedViews.current = prefs.saved_views;
      // A link's ?scope= and a choice made before the answer arrived both win over the saved scope.
      if (urlScope.current === null && !decidedByUser.current) setScopeState(scopeFromPrefs(prefs.brand_scope));
    }, () => undefined);
    void loadList();
    return () => { active = false; };
  }, [persist, loadList]);
  // The popover lists current brands, so opening it reads them again.
  useEffect(() => { if (persist && open) void loadList(); }, [persist, open, loadList]);

  const setScope = useCallback((next: BrandScope) => {
    decidedByUser.current = true;
    setScopeState(next);
    if (urlScope.current !== null) {
      urlScope.current = null;
      setFromUrl(false);
      const url = new URL(window.location.href);
      url.searchParams.delete("scope");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    if (persist) void api.saveMePrefs({ brand_scope: scopeToPrefs(next), saved_views: savedViews.current }).catch(() => undefined);
  }, [persist]);

  return useMemo(() => {
    const isVisible = (brand: ScopeBrand) => inScope(scope, brand);
    const visible = list ? list.filter((entry) => isVisible(entry.scope)).length : null;
    return { scope, setScope, list, visibleCount: visible, totalCount: list ? list.length : null, isVisible, open, setOpen, fromUrl };
  }, [scope, setScope, list, open, fromUrl]);
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
