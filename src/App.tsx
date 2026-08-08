import { useEffect, useState } from 'react'
import { useLocalState } from './useLocalState'
import Admin from './pages/Admin'
import Dashboard from './pages/Dashboard'
import Properties from './pages/Properties'
import Bills from './pages/Bills'
import ScrapeHistory from './pages/ScrapeHistory'
import AddressLookup from './pages/AddressLookup'
import Compliance from './pages/Compliance'
import Licensing from './pages/Licensing'
import LeadRegistry from './pages/LeadRegistry'
import TaxAddress from './pages/TaxAddress'
import AcnProgram from './pages/AcnProgram'
import AcnEmailSetup from './pages/AcnEmailSetup'
import './app.css'

type Page = 'acn' | 'acnsetup' | 'compliance' | 'licensing' | 'lead' | 'taxaddress' | 'properties' | 'lookup' | 'bills' | 'dashboard' | 'scrapes' | 'admin'

const PAGES: Page[] = ['acn', 'acnsetup', 'compliance', 'licensing', 'lead', 'taxaddress', 'properties', 'lookup', 'bills', 'dashboard', 'scrapes', 'admin']

const DEFAULT_NAME = 'KRS Property Compliance Monitor'

function pageFromUrl(): Page {
  const p = window.location.pathname.replace(/^\//, '')
  return (PAGES as string[]).includes(p) ? (p as Page) : 'compliance'
}

export default function App() {
  const [page, setPageState] = useState<Page>(pageFromUrl)
  const [returnPage, setReturnPage] = useState<Page | null>(null)
  const [editPropertyId, setEditPropertyId] = useState<number | null>(null)
  const [settings, setSettings] = useState<Record<string, string>>({})

  function setPage(p: Page) {
    if (p !== page) window.history.pushState(null, '', `/${p}`)
    setPageState(p)
  }

  useEffect(() => {
    const onPop = () => setPageState(pageFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  async function loadSettings() {
    try {
      const s = await fetch('/api/settings').then(r => r.json())
      setSettings(s)
      document.title = s.app_name || DEFAULT_NAME
      const root = document.documentElement
      if (s.primary_color) {
        root.style.setProperty('--blue', s.primary_color)
        root.style.setProperty('--blue-dark', s.primary_color)
      } else {
        root.style.removeProperty('--blue'); root.style.removeProperty('--blue-dark')
      }
      if (s.sidebar_color) root.style.setProperty('--sidebar-bg', s.sidebar_color)
      else root.style.removeProperty('--sidebar-bg')
      if (s.logo) {
        let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
        if (!link) {
          link = document.createElement('link')
          link.rel = 'icon'
          document.head.appendChild(link)
        }
        link.href = s.logo
      }
    } catch { /* keep defaults */ }
  }

  useEffect(() => { loadSettings() }, [])

  function goEditProperty(id: number) {
    setReturnPage(page !== 'properties' ? page : null)
    setEditPropertyId(id)
    setPage('properties')
  }

  function clearEditProperty() {
    setEditPropertyId(null)
  }

  // After saving/canceling an edit that came from another page, go back there
  function doneEditing() {
    setEditPropertyId(null)
    if (returnPage) {
      setPage(returnPage)
      setReturnPage(null)
    }
  }

  const nav = (p: Page, label: string) => (
    <button key={p} className={`nav-link ${page === p ? 'active' : ''}`} onClick={() => setPage(p)}>
      {label}
    </button>
  )

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-logo" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {settings.logo
            ? <img src={settings.logo} alt="logo" style={{ maxHeight: 36, maxWidth: 170 }} />
            : <span>🏠</span>}
          <span style={{ fontSize: settings.logo ? 12 : undefined }}>{settings.app_name || DEFAULT_NAME}</span>
        </div>
        <div className="nav-links">
          {nav('compliance', 'Compliance Dashboard')}
          {nav('licensing', 'Licensing')}
          {nav('lead', 'Lead Registry')}
          {nav('taxaddress', 'Tax Address')}
          {nav('acn', 'ACN Program')}
          {nav('properties', 'Properties')}
          {nav('lookup', 'Address Lookup')}
          {nav('dashboard', 'Water Dashboard')}
          {nav('bills', 'Water Bills')}
          {nav('scrapes', 'Scrape History')}
          <div className="nav-section">Settings</div>
          {nav('admin', 'Admin')}
        </div>
        <div className="nav-bottom">
          <a href="/auth/logout" className="nav-link" style={{ opacity: 0.6, fontSize: 12 }}>Sign out</a>
        </div>
      </nav>
      <main className="main">
        {page === 'compliance'  && <Compliance onEditProperty={goEditProperty} />}
        {page === 'licensing'   && <Licensing onEditProperty={goEditProperty} />}
        {page === 'lead'        && <LeadRegistry onEditProperty={goEditProperty} />}
        {page === 'taxaddress'  && <TaxAddress onEditProperty={goEditProperty} />}
        {page === 'acn'         && <AcnProgram onEditProperty={goEditProperty} onConfigure={() => setPage('acnsetup')} />}
        {page === 'acnsetup'    && <AcnEmailSetup />}
        {page === 'properties'  && <Properties editPropertyId={editPropertyId} onClearEditId={clearEditProperty} onDoneEditing={doneEditing} />}
        {page === 'lookup'      && <AddressLookup onAddProperties={() => setPage('properties')} />}
        {page === 'dashboard'   && <Dashboard onNavigate={p => setPage(p as Page)} />}
        {page === 'bills'       && <Bills />}
        {page === 'scrapes'     && <ScrapeHistory />}
        {page === 'admin'       && <Admin onSettingsSaved={loadSettings} />}
      </main>
    </div>
  )
}
