/**
 * Text that came from somewhere else, made safe to put on screen.
 *
 * Nothing here is about HTML — React escapes that. It is about a string being able to CHOOSE HOW
 * IT IS LAID OUT. A symbol of "USDC‮toor" renders as "USDCroot"; a zero-width space inside a
 * name makes an exact look-alike of one the user already trusts; a bidi isolate around a number
 * moves the digits. The whole premise of this app is that the user reads what the chain says
 * before signing, so nothing the chain (or an explorer's API, or a revert string) says may decide
 * how its own characters are ordered.
 *
 * No imports on purpose, and the file it lives in is loadable by plain Node: scripts/gen-headers.mjs
 * pulls src/core/track.ts, which pulls this.
 */

/**
 * Bidi controls, isolates, joiners, soft hyphen, the BOM and the C0/C1 control ranges.
 * Ordinary non-ASCII is kept — plenty of honest tokens use it — and flagged instead by
 * labelLooksSpoofed(), which never blocks.
 */
const UNSAFE_TEXT_CHARS = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g

/** Strips the characters above, trims, and caps the length. Anything not a string becomes ''. */
export function sanitizeText(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return s.replace(UNSAFE_TEXT_CHARS, '').trim().slice(0, max)
}

/** A short on-screen label: a token symbol, a name, a fee description. */
export function sanitizeLabel(s: unknown, max = 32): string {
  return sanitizeText(s, max)
}

/**
 * True when a label carries characters that can impersonate ASCII — Cyrillic А, Greek Ο
 * and friends look exactly like A and O in most fonts. Informational only (§6.16): the label is
 * shown either way, with a flag next to it.
 */
export function labelLooksSpoofed(label: string): boolean {
  return /[Ͱ-ϿЀ-ӿԀ-ԯ℀-⅏＀-￯]/.test(label)
}
