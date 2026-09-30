'use client'
/**
 * The one tick, held by a send screen: given for a scope and a list of warnings (core/riskTick.ts),
 * and counting only while both are still what is on screen.
 *
 * `accepted` is derived, so a stale tick never survives a render. The effect below additionally
 * FORGETS the grant once it stops applying, so that coming back to an earlier amount, or a warning
 * that flickers away and back, does not revive a tick given before the list was last looked at.
 * When the list grew, what grew is kept (`added`) so the screen can point at it: the user is not
 * told "tick again", they are shown what they have not read yet.
 */
import { useEffect, useMemo, useState } from 'react'
import { tickCovers, warningMarks, warningsSince, type TickGrant, type WarningMark } from '@/core/riskTick'

export function useRiskTick(scope: string | null, warnings: readonly { code: string }[]) {
  // A string key so the effect runs on a change of content, not on every render's fresh array.
  const key = JSON.stringify(warningMarks(warnings))
  const marks = useMemo<WarningMark[]>(() => JSON.parse(key) as WarningMark[], [key])
  const [grant, setGrant] = useState<TickGrant | null>(null)
  const [added, setAdded] = useState<readonly WarningMark[]>([])

  const accepted = tickCovers(grant, scope, marks)

  useEffect(() => {
    if (grant === null) return
    if (grant.scope !== scope) {
      // A different transfer: the tick is simply not about it, and there is nothing to point at.
      setGrant(null)
      setAdded([])
      return
    }
    const since = warningsSince(grant.warnings, marks)
    if (since.length > 0) {
      setGrant(null)
      setAdded(since)
    }
  }, [grant, scope, marks])

  const setAccepted = (v: boolean) => {
    setGrant(v && scope !== null ? { scope, warnings: marks } : null)
    setAdded([])
  }

  // Only what is still on screen is worth pointing at; the rest went away on its own.
  const stillAdded = useMemo(() => added.filter((a) => marks.some((m) => m.code === a.code)), [added, marks])

  return { accepted, setAccepted, added: stillAdded }
}
