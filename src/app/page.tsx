'use client'
/**
 * The root sends you to the tab you used last (OFT by default). Each tab is a real page in the
 * static export, so this is the only redirect in the app.
 */
import { useEffect } from 'react'
import { tabPath } from '@/core/protocols'
import { Loading } from '@/ui/AppEntry'
import { loadLastTab } from '@/ui/tabs'

export default function Home() {
  useEffect(() => {
    window.location.replace(tabPath(loadLastTab()))
  }, [])
  return <Loading />
}
