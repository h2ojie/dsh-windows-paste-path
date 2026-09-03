/**
 * Client half of the Windows paste-path plugin.
 *
 * Runs in the DSH Web page. Its only job is to intercept a paste that carries
 * file/directory data, ask the host for the real paths, and insert them as
 * plain text. Everything else is left to DSH's native composer.
 *
 * Mapped/network drives are the hard case: Chromium often withholds File
 * objects and instead exposes file:// HTML (spaces encoded as &#x20;). The
 * host snapshot is the authority whenever it has entries.
 */

window.__ModuleLoader__.load({
  id: 'dsh-windows-paste-path',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    const ROUTE_PATHS = '/api/clipboard/paths'
    const ROUTE_MEDIA_TYPES = '/api/clipboard/media-types'
    const PATHS_FETCH_TIMEOUT_MS = 2000

    const COMPOSER_CARD = '[data-composer-card]'
    const COMPOSER_INPUT = '[data-composer-input]'
    const INPUT_SCROLL = '[data-input-scroll]'

    const FALLBACK_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
    const IMAGE_EXTENSIONS = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      jfif: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      avif: 'image/avif',
      svg: 'image/svg+xml',
    }
    let supportedMediaTypes = FALLBACK_MEDIA_TYPES
    let pasteSeq = 0
    let insertingText = false

    function asElement(target) {
      if (target instanceof Element) return target
      if (target instanceof Text) return target.parentElement
      return null
    }

    function composerInputFrom(target) {
      const el = asElement(target)
      if (el === null) return null
      const card = el.closest(COMPOSER_CARD)
      if (card === null) return null
      return (
        card.querySelector(COMPOSER_INPUT) ??
        card.querySelector(`${INPUT_SCROLL} [contenteditable='true']`) ??
        card.querySelector(`${INPUT_SCROLL} textarea[data-phase]`)
      )
    }

    function isUsableComposerInput(input) {
      if (!(input instanceof Element)) return false
      if (input.getAttribute('aria-haspopup') === 'menu') return false
      if (input.getAttribute('aria-disabled') === 'true') return false
      if (input instanceof HTMLTextAreaElement) return !input.disabled
      if (input.getAttribute('contenteditable') === 'true') return true
      return input.hasAttribute('data-composer-input') && input.getAttribute('contenteditable') !== 'false'
    }

    function mediaTypeFromName(name) {
      if (typeof name !== 'string' || name.length === 0) return ''
      const dot = name.lastIndexOf('.')
      if (dot < 0 || dot === name.length - 1) return ''
      const ext = name.slice(dot + 1).toLowerCase()
      return IMAGE_EXTENSIONS[ext] ?? ''
    }

    function isSupportedImageType(mediaType) {
      if (typeof mediaType !== 'string' || mediaType.length === 0) return false
      return supportedMediaTypes.includes(mediaType.toLowerCase())
    }

    function fileCandidatesFrom(clipboardData) {
      const candidates = []
      const items = clipboardData.items ? Array.from(clipboardData.items) : []
      for (const item of items) {
        if (item.kind !== 'file') continue
        // Reading kind/type is metadata-only. Never call getAsFile() or touch
        // clipboardData.files here: Chromium may synchronously materialize an
        // Explorer folder's CF_HDROP and spin the renderer before our handler
        // can prevent the native paste.
        candidates.push({ mediaType: item.type || '' })
      }
      return candidates
    }

    function clipboardText(clipboardData, type) {
      try {
        return clipboardData.getData(type) || ''
      } catch {
        return ''
      }
    }

    function decodeHtmlEntities(value) {
      return value
        .replace(/&#x20;|&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    }

    function fileUrlToWindowsPath(url) {
      try {
        let decoded = decodeURIComponent(url.trim())
        decoded = decoded.replace(/^file:\/\//i, '')
        if (decoded.startsWith('localhost/')) decoded = decoded.slice('localhost/'.length)
        decoded = decoded.replace(/^\/+/, '')
        decoded = decoded.replace(/\//g, '\\')
        if (/^[A-Za-z]:\\/.test(decoded) || decoded.startsWith('\\\\')) return decoded
      } catch {
        return ''
      }
      return ''
    }

    function isWindowsAbsPath(value) {
      return /^[A-Za-z]:\\/.test(value) || value.startsWith('\\\\')
    }

    function pathsFromClipboardText(clipboardData) {
      const plain = decodeHtmlEntities(clipboardText(clipboardData, 'text/plain')).trim()
      const html = clipboardText(clipboardData, 'text/html')
      const uriList = clipboardText(clipboardData, 'text/uri-list')
      const found = []
      if (isWindowsAbsPath(plain) && !plain.includes('\n')) found.push(plain)
      const blob = [plain, uriList, html].join('\n')
      const urls = blob.match(/file:\/\/[^\s"'<>]+/gi) || []
      for (const url of urls) {
        const path = fileUrlToWindowsPath(url)
        if (path) found.push(path)
      }
      return uniquePaths(found)
    }

    function uniquePaths(paths) {
      const seen = new Set()
      const out = []
      for (const path of paths) {
        const key = path.replace(/\//g, '\\').toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(path)
      }
      return out
    }

    function clipboardLooksLikeFileDrop(clipboardData) {
      const types = clipboardData.types ? Array.from(clipboardData.types) : []
      if (types.includes('Files') || types.includes('text/uri-list')) return true
      if (clipboardData.files && clipboardData.files.length > 0) return true
      const items = clipboardData.items ? Array.from(clipboardData.items) : []
      if (items.some((item) => item.kind === 'file')) return true
      const html = clipboardText(clipboardData, 'text/html')
      // A plain Windows-looking string is still ordinary text. Treating
      // `C:\\...` as a file-drop signal steals normal text paste, blocks the
      // native composer, and adds a two-second Host round trip. Explorer's
      // mapped-drive fallback carries file:// HTML, which remains sufficient.
      return /file:\/\//i.test(html)
    }

    function shouldIntercept(candidates, looksLikeFiles) {
      if (candidates.some((c) => isSupportedImageType(c.mediaType))) return false
      return looksLikeFiles || candidates.length > 0
    }

    function fetchJson(url, timeoutMs) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      return fetch(url, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error('bad status ' + res.status))))
        .finally(() => clearTimeout(timer))
    }

    function fetchMediaTypes() {
      return fetchJson(ROUTE_MEDIA_TYPES, PATHS_FETCH_TIMEOUT_MS)
        .then((body) => {
          if (body && Array.isArray(body.mediaTypes)) {
            supportedMediaTypes = body.mediaTypes.filter((t) => typeof t === 'string').map((t) => t.toLowerCase())
          }
        })
        .catch(() => {})
    }

    function fetchPaths() {
      return fetchJson(ROUTE_PATHS, PATHS_FETCH_TIMEOUT_MS).then((body) => {
        if (!body || body.supported !== true || !Array.isArray(body.items)) return []
        return uniquePaths(
          body.items
            .filter((it) => it && (it.kind === 'file' || it.kind === 'directory') && typeof it.path === 'string')
            .map((it) => it.path.trim())
            .filter((path) => path.length > 0),
        )
      })
    }

    function insertPlainText(input, text) {
      if (typeof input.focus === 'function') input.focus()
      if (input instanceof HTMLTextAreaElement) {
        const start = input.selectionStart ?? input.value.length
        const end = input.selectionEnd ?? start
        input.setRangeText(text, start, end, 'end')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return
      }
      // Mapped-drive pastes often keep file:// HTML on the system clipboard.
      // Never dispatch a synthetic ClipboardEvent: Chromium may ignore our
      // DataTransfer and re-read that HTML, which duplicates the path and
      // inserts &#x20; entities. Some Chromium/extension combinations can surface
      // execCommand's edit as a re-entrant paste; ignore only that synchronous
      // insertion window so it cannot spin the renderer.
      insertingText = true
      try {
        document.execCommand('insertText', false, text)
      } finally {
        insertingText = false
      }
    }

    function resolveInsertTarget(fallbackNode) {
      const active = document.activeElement
      const fromActive = composerInputFrom(active)
      if (isUsableComposerInput(fromActive)) return fromActive
      if (isUsableComposerInput(active) && active.closest(COMPOSER_CARD) !== null) return active
      const fromFallback = composerInputFrom(fallbackNode)
      if (isUsableComposerInput(fromFallback)) return fromFallback
      const focused = document.querySelector(`${COMPOSER_INPUT}[contenteditable='true']`)
      return isUsableComposerInput(focused) ? focused : null
    }

    function handlePaste(event) {
      if (event.defaultPrevented || insertingText) return

      const clipboardData = event.clipboardData ?? (event.originalEvent && event.originalEvent.clipboardData)
      if (clipboardData == null) return

      // Ordinary text paste must exit before getData(), getAsFile(), or any
      // other clipboard payload read. Besides avoiding false positives, this
      // keeps the plugin completely out of Chromium's synchronous clipboard
      // materialization path unless the browser explicitly advertises files.
      const types = clipboardData.types ? Array.from(clipboardData.types) : []
      const advertisesFiles = types.includes('Files')
      const advertisesUriList = types.includes('text/uri-list')
      if (!advertisesFiles && !advertisesUriList) return

      // URI-list alone can represent an ordinary link. A Files payload is
      // inspected only far enough to preserve DSH's supported-image path; the
      // real absolute paths still come exclusively from the Hook snapshot.
      if (!advertisesFiles) return
      const candidates = fileCandidatesFrom(clipboardData)
      if (candidates.some((candidate) => isSupportedImageType(candidate.mediaType))) return

      event.preventDefault()
      event.stopPropagation()
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()

      const seq = ++pasteSeq
      const input = resolveInsertTarget(event.target)

      fetchPaths()
        .then((paths) => {
          if (seq !== pasteSeq || paths.length === 0) return
          const target = resolveInsertTarget(event.target) ?? input
          if (!isUsableComposerInput(target)) return
          insertPlainText(target, paths.join('\n'))
        })
        .catch(() => {})
    }

    function apply(ctx) {
      const onFocus = () => { fetchMediaTypes() }
      const start = () => {
        fetchMediaTypes()
        document.addEventListener('paste', handlePaste, true)
        window.addEventListener('focus', onFocus)
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true })
      } else {
        start()
      }

      ctx.effect(() => () => {
        document.removeEventListener('paste', handlePaste, true)
        window.removeEventListener('focus', onFocus)
        document.removeEventListener('DOMContentLoaded', start)
      }, 'dsh-windows-paste-path: paste listener')
    }

    exports.apply = apply
    return module.exports
  },
})
