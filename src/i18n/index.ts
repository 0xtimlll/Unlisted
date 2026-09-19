/**
 * Single-language (EN) dictionary with `{placeholder}` interpolation. The typed
 * dictionary stays so every UI string lives in one place.
 */
import { en, type Dict } from './en'

export type { Dict }

export function useDict(): Dict {
  return en
}

/** "Hello {name}" + {name: 'x'} -> "Hello x". Values are inserted as text, never HTML. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}
