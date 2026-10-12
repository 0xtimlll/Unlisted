/**
 * Single-language (EN) dictionary with `{placeholder}` interpolation. The typed
 * dictionary stays so every UI string lives in one place.
 */
import type { ProtocolId } from '@/core/protocols'
import { en, type Dict } from './en'

export type { Dict }

export function useDict(): Dict {
  return en
}

/** "Hello {name}" + {name: 'x'} -> "Hello x". Values are inserted as text, never HTML. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

/** Short badge for a protocol ("OFT"). Explicit branches so the dictionary stays type-checked. */
export function protocolBadge(d: Dict, id: ProtocolId): string {
  switch (id) {
    case 'lz-oft':
      return d.protocols.badge_lz_oft
    case 'wormhole-ntt':
      return d.protocols.badge_wormhole_ntt
    case 'ccip':
      return d.protocols.badge_ccip
    case 'hyperlane':
      return d.protocols.badge_hyperlane
  }
}

/** Full name of a protocol ("LayerZero OFT"). */
export function protocolName(d: Dict, id: ProtocolId): string {
  switch (id) {
    case 'lz-oft':
      return d.protocols.name_lz_oft
    case 'wormhole-ntt':
      return d.protocols.name_wormhole_ntt
    case 'ccip':
      return d.protocols.name_ccip
    case 'hyperlane':
      return d.protocols.name_hyperlane
  }
}
