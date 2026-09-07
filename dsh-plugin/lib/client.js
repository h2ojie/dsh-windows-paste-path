/**
 * Alt+V inserts the Windows Hook's path snapshot into the focused DSH composer.
 * Native paste events and Ctrl+V belong exclusively to DSH.
 */
window.__ModuleLoader__.load({
  id: 'dsh-windows-paste-path',
  factory: () => {
    const ROUTE_PATHS = '/api/clipboard/paths'
    const PATHS_FETCH_TIMEOUT_MS = 2000
    let pasteSeq = 0

    function composerInputFrom(target) {
      const el = target instanceof Element ? target : target instanceof Text ? target.parentElement : null
      const card = el?.closest('[data-composer-card]')
      if (!card) return null
      return card.querySelector('[data-composer-input]') ??
        card.querySelector("[data-input-scroll] [contenteditable='true']") ??
        card.querySelector('[data-input-scroll] textarea[data-phase]')
    }

    function isUsableComposerInput(input) {
      if (!(input instanceof Element)) return false
      if (input.getAttribute('aria-haspopup') === 'menu') return false
      if (input.getAttribute('aria-disabled') === 'true') return false
      if (input instanceof HTMLTextAreaElement) return !input.disabled
      if (input.getAttribute('contenteditable') === 'true') return true
      return input.hasAttribute('data-composer-input') && input.getAttribute('contenteditable') !== 'false'
    }

    async function fetchPaths() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PATHS_FETCH_TIMEOUT_MS)
      try {
        const response = await fetch(ROUTE_PATHS, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        })
        if (!response.ok) throw new Error('bad status ' + response.status)
        const body = await response.json()
        if (!body || body.supported !== true || !Array.isArray(body.items)) return []
        const seen = new Set()
        return body.items
          .filter(it => it && (it.kind === 'file' || it.kind === 'directory') && typeof it.path === 'string')
          .map(it => it.path.trim())
          .filter(path => {
            if (!path) return false
            const key = path.replace(/\//g, '\\').toLowerCase()
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
      } finally {
        clearTimeout(timer)
      }
    }

    function insertPlainText(input, text) {
      input.focus()
      if (input instanceof HTMLTextAreaElement) {
        const start = input.selectionStart ?? input.value.length
        const end = input.selectionEnd ?? start
        input.setRangeText(text, start, end, 'end')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
      // Insert only the supplied text; never invoke native paste or read the clipboard.
      document.execCommand('insertText', false, text)
    }

    function handlePathShortcut(event) {
      if (event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return
      if (event.code !== 'KeyV' && event.key?.toLowerCase() !== 'v') return
      if (event.defaultPrevented || event.isComposing || event.getModifierState?.('AltGraph')) return
      const input = composerInputFrom(event.target)
      if (!isUsableComposerInput(input) || !input.contains(event.target)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation?.()
      if (event.repeat) return
      const seq = ++pasteSeq
      fetchPaths()
        .then(paths => {
          if (seq !== pasteSeq || paths.length === 0 || !input.isConnected) return
          if (!isUsableComposerInput(input) || !input.contains(document.activeElement)) return
          insertPlainText(input, paths.join('\n'))
        })
        .catch(() => {}) // Failed snapshot reads never fall back to native file paste.
    }

    function apply(ctx) {
      const start = () => document.addEventListener('keydown', handlePathShortcut, true)
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      } else {
        start()
      }
      ctx.effect(() => () => {
        pasteSeq += 1
        document.removeEventListener('keydown', handlePathShortcut, true)
        document.removeEventListener('DOMContentLoaded', start)
      }, 'dsh-windows-paste-path: Alt+V listener')
    }
    return { apply }
  },
})
