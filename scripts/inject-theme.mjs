#!/usr/bin/env node
/**
 * Post-build: puts `public/theme.js` into the <head> of every exported page.
 *
 * The stored theme has to be applied before the first paint, or a light-theme visitor sees the
 * dark one flash past. That means a plain, render-blocking <script src> in the head — and React
 * will not emit one from the layout: a script without `async` is hoisted out of the tree and left
 * as a preload for the runtime to fetch, which is far too late. So it is written in here, where
 * the export is already being post-processed for headers.
 *
 * A file rather than an inline script on purpose: the page keeps shipping no inline script of its
 * own, and the CSP needs nothing but 'self' for it.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = new URL('../out/', import.meta.url).pathname
const TAG = '<script src="/theme.js"></script>'

function htmlFiles(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) htmlFiles(p, acc)
    else if (n.endsWith('.html')) acc.push(p)
  }
  return acc
}

let touched = 0
for (const f of htmlFiles(OUT)) {
  const html = readFileSync(f, 'utf8')
  if (html.includes(TAG)) continue
  const i = html.indexOf('<head>')
  if (i < 0) continue
  writeFileSync(f, html.slice(0, i + 6) + TAG + html.slice(i + 6))
  touched++
}
console.log(`inject-theme: ${TAG} added to ${touched} page(s)`)
