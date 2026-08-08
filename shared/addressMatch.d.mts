export function streetKey(address: string | null | undefined): string
export function looseStreetKey(address: string | null | undefined): string
export function unitlessStreetKey(address: string | null | undefined): string
export function noDirectionKey(address: string | null | undefined): string

export function buildMatchIndex<T extends { address?: string | null }>(properties: T[]): {
  find(address: string): { property: T; exact: boolean } | null
}
