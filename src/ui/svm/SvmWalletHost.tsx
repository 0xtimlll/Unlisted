'use client'
/**
 * Hosts the Solana wallet slot without ever remounting the app. When `enabled`, the adapter stack
 * (a separate chunk) mounts as a SIBLING of the app and reports its state through context; when
 * disabled, the context is inert and no Solana code is downloaded (§7.3).
 */
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { INERT_SVM_WALLET, SvmWalletContext, type SvmWallet } from './context'

const SolanaStack = lazy(() => import('./SolanaStack'))

export function SvmWalletHost({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const [state, setState] = useState<SvmWallet>(INERT_SVM_WALLET)
  const onState = useCallback((s: SvmWallet) => setState(s), [])
  useEffect(() => {
    if (!enabled) setState(INERT_SVM_WALLET)
  }, [enabled])
  return (
    <SvmWalletContext.Provider value={enabled ? state : INERT_SVM_WALLET}>
      {children}
      {enabled ? (
        <Suspense fallback={null}>
          <SolanaStack onState={onState} />
        </Suspense>
      ) : null}
    </SvmWalletContext.Provider>
  )
}
