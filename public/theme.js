/*
 * The theme, before anything is painted. The document ships in the dark theme, so this only has
 * to undo it for someone who chose light — no flash either way, and no second source of truth:
 * the value read here is the one src/ui/storage.ts writes.
 *
 * A file rather than an inline script on purpose: the app ships no inline scripts of its own, and
 * this way the CSP needs nothing but 'self' for it.
 */
;(function () {
  try {
    var raw = localStorage.getItem('oft-bridge-ui:v1')
    var theme = raw ? JSON.parse(raw).theme : null
    if (theme === 'light') {
      document.documentElement.classList.remove('dark')
      document.documentElement.style.colorScheme = 'light'
    }
  } catch {
    /* private mode — the default dark theme stands */
  }
})()
