import React, { useState } from 'react'
import { Sidebar } from './components/layout/Sidebar'
import { MobileTopBar } from './components/layout/MobileTopBar'
import { Home } from './pages/Home'
import { Brands } from './pages/Brands'
import { NewBrand } from './pages/NewBrand'
import { Templates } from './pages/Templates'
import { Campaigns } from './pages/Campaigns'
import { Traffic } from './pages/Traffic'
import { Leads } from './pages/Leads'
import { Alerts } from './pages/Alerts'
import { AdkitTerminal } from './pages/AdkitTerminal'
import { Settings } from './pages/Settings'
import { defaultBrandScope } from './utils/brandScope'
import type { BrandScope, PageId } from './types/app'

export function App() {
  const [page, setPage] = useState<PageId>('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [brandId, setBrandId] = useState('willow')
  const [scope, setScope] = useState<BrandScope>(defaultBrandScope)
  const navigate = (p: PageId) => { setPage(p); setMenuOpen(false); window.scrollTo({ top: 0 }) }
  const openBrand = (id: string) => { setBrandId(id); navigate('brands') }
  const editScope = () => setScopeOpen(true)
  const renderPage = () => { switch (page) {
    case 'home': return <Home onNavigate={navigate} onOpenBrand={openBrand} scope={scope} onEditScope={editScope}/>
    case 'brands': return <Brands selectedId={brandId} onSelect={setBrandId} onCreate={() => navigate('new-brand')} scope={scope} onEditScope={editScope}/>
    case 'new-brand': return <NewBrand onBack={() => navigate('brands')} />
    case 'templates': return <Templates scope={scope} onEditScope={editScope}/>
    case 'campaigns': return <Campaigns scope={scope} onEditScope={editScope}/>
    case 'traffic': return <Traffic scope={scope} onEditScope={editScope} onOpenBrand={openBrand}/>
    case 'leads': return <Leads scope={scope} onEditScope={editScope}/>
    case 'alerts': return <Alerts onOpenBrand={openBrand} scope={scope} onEditScope={editScope}/>
    case 'adkit': return <AdkitTerminal scope={scope} onEditScope={editScope}/>
    case 'settings': return <Settings scope={scope} onEditScope={editScope}/>
  }}
  return <div lang="th" className="flex min-h-screen w-full bg-canvas text-ink"><Sidebar active={page} open={menuOpen} onNavigate={navigate} onClose={() => setMenuOpen(false)} scope={scope} onScopeApply={setScope} scopeOpen={scopeOpen} onScopeOpenChange={setScopeOpen}/><div className="min-w-0 flex-1"><MobileTopBar onOpen={() => setMenuOpen(true)} scope={scope} onScopeApply={setScope} scopeOpen={scopeOpen} onScopeOpenChange={setScopeOpen}/><main className="mx-auto w-full max-w-[1128px] px-4 py-6 md:px-8 md:py-8">{renderPage()}</main></div></div>
}
