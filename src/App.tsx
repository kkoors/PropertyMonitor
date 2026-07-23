import { useLocalState } from './useLocalState'
import Dashboard from './pages/Dashboard'
import Properties from './pages/Properties'
import Bills from './pages/Bills'
import ScrapeHistory from './pages/ScrapeHistory'
import AddressLookup from './pages/AddressLookup'
import './app.css'

type Page = 'dashboard' | 'properties' | 'bills' | 'scrapes' | 'lookup'

export default function App() {
  const [page, setPage] = useLocalState<Page>('app.page', 'dashboard')

  return (
    <div className="app">
      <nav className="nav">
        <span className="nav-logo">💧 Water Bills</span>
        <div className="nav-links">
          {(['dashboard', 'properties', 'lookup', 'bills', 'scrapes'] as Page[]).map(p => (
            <button key={p} className={`nav-link ${page === p ? 'active' : ''}`} onClick={() => setPage(p)}>
              {{ dashboard: 'Dashboard', properties: 'Properties', lookup: 'Address Lookup', bills: 'Bills', scrapes: 'Scrape History' }[p]}
            </button>
          ))}
          <a href="/auth/logout" className="nav-link" style={{ marginLeft: 16, fontSize: 13, opacity: 0.7 }}>Sign out</a>
        </div>
      </nav>
      <main className="main">
        {page === 'dashboard' && <Dashboard onNavigate={setPage} />}
        {page === 'properties' && <Properties />}
        {page === 'bills' && <Bills />}
        {page === 'scrapes' && <ScrapeHistory />}
        {page === 'lookup' && <AddressLookup onAddProperties={() => setPage('properties')} />}
      </main>
    </div>
  )
}
