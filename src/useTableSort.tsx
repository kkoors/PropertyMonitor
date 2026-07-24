import type React from 'react'
import { useLocalState } from './useLocalState'

// Shared search + click-to-sort helpers for list pages
export function useTableSort(storageKey: string, defaultCol: string) {
  const [sortCol, setSortCol] = useLocalState<string>(`${storageKey}.sortCol`, defaultCol)
  const [sortDir, setSortDir] = useLocalState<'asc' | 'desc'>(`${storageKey}.sortDir`, 'asc')
  const [search, setSearch] = useLocalState<string>(`${storageKey}.search`, '')

  function toggleSort(col: string) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const Th = ({ col, children }: { col: string; children: React.ReactNode }) => (
    <th style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(col)}>
      {children}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  )

  function apply<T extends Record<string, any>>(rows: T[], searchFields: (r: T) => (string | null | undefined)[], numericCols: Set<string> = new Set(), getVal?: (r: T, col: string) => any) {
    const q = search.toLowerCase()
    return rows
      .filter(r => !q || searchFields(r).some(v => v?.toLowerCase().includes(q)))
      .sort((a, b) => {
        const av = getVal ? getVal(a, sortCol) : a[sortCol]
        const bv = getVal ? getVal(b, sortCol) : b[sortCol]
        const aa = av ?? (numericCols.has(sortCol) ? -Infinity : '')
        const bb = bv ?? (numericCols.has(sortCol) ? -Infinity : '')
        const cmp = numericCols.has(sortCol) ? Number(aa) - Number(bb) : String(aa).localeCompare(String(bb))
        return sortDir === 'asc' ? cmp : -cmp
      })
  }

  return { search, setSearch, sortCol, sortDir, toggleSort, Th, apply }
}
