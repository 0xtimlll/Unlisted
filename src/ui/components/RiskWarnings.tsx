'use client'
/**
 * Everything wrong with this transfer, in one place, and the single tick that covers it.
 *
 * Two lists, and the difference between them is the whole of core/severity.ts:
 *
 *   blocks    the button stays down whatever the user says — the money would certainly be lost, or
 *             the transaction certainly would not go. Shown with what to do about each one, and
 *             NO tick, because there is nothing here to accept.
 *   warnings  the app's opinion about someone else's contract. Sorted with the ones that can cost
 *             the transfer at the top, and one tick opens any amount, "Max" included.
 *
 * The tick is deliberately one tick rather than one per warning: a row of boxes teaches people to
 * clear boxes. One box, with the worst sentence directly above it, is a decision.
 *
 * Nothing here decides anything — the screens pass `risksAccepted` back into the guards, and the
 * guards are what hold the button. This component cannot let anything through on its own.
 */
import { warningWeight, type WarningWeight } from '@/core/severity'
import { useDict } from '@/i18n'

/** A failed guard, as every tab's report already carries it. */
export type ShownGuard = { id: number; ok: false; code: string; detail?: string }

const WEIGHT_CLASS: Record<WarningWeight, string> = {
  loss: 'border-danger/40 bg-danger/10 text-danger',
  stuck: 'border-warn/40 bg-warn/10 text-warn',
  note: 'border-line bg-surface-2 text-muted',
}

const WEIGHT_GLYPH: Record<WarningWeight, string> = { loss: '⛔', stuck: '⚠', note: '·' }

export function RiskWarnings(p: {
  blocks: readonly ShownGuard[]
  warnings: readonly ShownGuard[]
  /** The tab's own guard dictionary, since each protocol names its codes separately. */
  label: (code: string) => string
  accepted: boolean
  onAccepted: (v: boolean) => void
  /** Reads still in flight are not shown as problems; the screens filter them out first. */
}) {
  const d = useDict()
  if (p.blocks.length === 0 && p.warnings.length === 0) return null

  return (
    <div className="space-y-2">
      {p.blocks.length > 0 ? (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          <div className="font-semibold">{d.risks.blockedTitle}</div>
          <ul className="mt-1 space-y-1 text-xs">
            {p.blocks.map((b) => (
              <li key={`${b.id}-${b.code}`}>✗ {p.label(b.code)}</li>
            ))}
          </ul>
          <p className="mt-2 text-xs opacity-90">{d.risks.blockedHint}</p>
        </div>
      ) : null}

      {p.warnings.length > 0 ? (
        <div className="space-y-1">
          {p.warnings.map((w) => {
            const weight = warningWeight(w.code)
            return (
              <div key={`${w.id}-${w.code}`} className={`rounded-xl border px-3 py-2 text-xs ${WEIGHT_CLASS[weight]}`}>
                <span className="mr-1">{WEIGHT_GLYPH[weight]}</span>
                {p.label(w.code)}
                {/* The strongest ones say what to do about them, not just what is wrong. */}
                {weight === 'loss' ? <div className="mt-1 font-semibold">{d.risks.testFirst}</div> : null}
              </div>
            )
          })}

          {/* No tick while something blocks: there would be nothing it could open. */}
          {p.blocks.length === 0 ? (
            <label className="mt-2 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
              <input type="checkbox" className="mt-1" checked={p.accepted} onChange={(e) => p.onAccepted(e.target.checked)} />
              <span>{d.risks.acceptAll}</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
