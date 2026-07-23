import { useLocalState } from './useLocalState'
import Dashboard from './pages/Dashboard'
import Properties from './pages/Properties'
import Bills from './pages/Bills'
import ScrapeHistory from './pages/ScrapeHistory'
import AddressLookup from './pages/AddressLookup'
import Compliance from './pages/Compliance'
import './app.css'

type Page = 'compliance' | 'properties' | 'lookup' | 'bills' | 'dashboard' | 'scrapes'

export default function App() {
  const [page, setPage] = useLocalState<Page>('app.page', 'compliance')

  const nav = (p: Page, label: string) => (
    <button key={p} className={`nav-link ${page === p ? 'active' : ''}`} onClick={() => setPage(p)}>
      {label}
    </button>
  )

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-logo">🏠 Property Monitor</div>
        <div className="nav-links">
          <div className="nav-section">Compliance</div>
          {nav('compliance', 'Compliance')}
          {nav('properties', 'Properties')}
          {nav('lookup', 'Address Lookup')}
          <div className="nav-section">Water</div>
          {nav('dashboard', 'Water Dashboard')}
          {nav('bills', 'Bills')}
          {nav('scrapes', 'Scrape History')}
        </div>
        <div className="nav-bottom">
          <a href="/auth/logout" className="nav-link" style={{ opacity: 0.6, fontSize: 12 }}>Sign out</a>
        </div>
      </nav>
      <main className="main">
        {page === 'compliance'  && <Compliance />}
        {page === 'properties'  && <Properties />}
        {page === 'lookup'      && <AddressLookup onAddProperties={() => setPage('properties')} />}
        {page === 'dashboard'   && <Dashboard onNavigate={p => setPage(p as Page)} />}
        {page === 'bills'       && <Bills />}
        {page === 'scrapes'     && <ScrapeHistory />}
      </main>
    </div>
  )
}
