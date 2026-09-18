'use client'
/**
 * Tiny i18n: typed dictionary, `{placeholder}` interpolation, no library.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { en, type Dict } from './en'
import { ru } from './ru'

export type { Dict }
export type Lang = 'en' | 'ru'
export const LANGS: readonly Lang[] = ['en', 'ru']
const DICTS: Record<Lang, Dict> = { en, ru }

type Ctx = { lang: Lang; dict: Dict; setLang: (l: Lang) => void }
const LangContext = createContext<Ctx>({ lang: 'en', dict: en, setLang: () => {} })

export function LangProvider({ initial, onChange, children }: { initial: Lang; onChange?: (l: Lang) => void; children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initial)
  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l)
      onChange?.(l)
    },
    [onChange],
  )
  const value = useMemo(() => ({ lang, dict: DICTS[lang], setLang }), [lang, setLang])
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>
}

export function useLang() {
  return useContext(LangContext)
}

export function useDict(): Dict {
  return useContext(LangContext).dict
}

/** "Hello {name}" + {name: 'x'} -> "Hello x". Values are inserted as text, never HTML. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

export function isLang(s: unknown): s is Lang {
  return s === 'en' || s === 'ru'
}
