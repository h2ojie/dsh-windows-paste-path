/**
 * Host half of the Windows paste-path plugin.
 *
 * Owns two routes on the shared `/api` channel and nothing else:
 *
 * - `/api/clipboard/paths`       — the snapshot written by DshClipboardHook;
 * - `/api/clipboard/media-types` — the deployment's supported image media types.
 *
 * Both go through `connection.fetch.register`, which means the harness applies
 * its Host/Origin trust fence and browser authentication before these handlers
 * run. Registering on `webServer` directly would skip all of that.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */

import nodeFs from 'node:fs'
import nodePath from 'node:path'

/** @type {readonly string[]} */
export const inject = ['connection', 'attachments']

export const name = 'dsh-windows-paste-path'

const PATHS_ROUTE = '/api/clipboard/paths'
const MEDIA_TYPES_ROUTE = '/api/clipboard/media-types'

const STATE_FILE_NAME = 'clipboard-paths.json'
const STATE_DIRECTORY_NAME = 'DshClipboardHook'

// Upper bounds on what we are willing to read and hand back.
const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024
const MAX_ITEMS = 256
const MAX_PATH_LENGTH = 32 * 1024
const MAX_MEDIA_TYPE_LENGTH = 128
const MAX_MEDIA_TYPES = 64

// Control characters and DEL cannot occur in a real path and would corrupt
// composer content, so they are rejected outright.
// eslint-disable-next-line no-control-regex
const ILLEGAL_PATH_CHARACTERS = /[\u0000-\u001f\u007f]/

const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]{1,64}\/[A-Za-z0-9!#$&^_.+-]{1,64}$/

/**
 * Resolve the snapshot path without letting configuration or request input
 * influence it. The route must never read an arbitrary location.
 *
 * @returns {string | undefined} absolute path, or undefined off Windows.
 */
function resolveStateFilePath() {
  if (process.platform !== 'win32') {
    return undefined
  }
  const localAppData = process.env.LOCALAPPDATA
  if (typeof localAppData !== 'string' || localAppData.length === 0) {
    return undefined
  }
  return nodePath.join(localAppData, STATE_DIRECTORY_NAME, STATE_FILE_NAME)
}

/**
 * Read the snapshot. A missing file and malformed content are the same outcome
 * for the caller: nothing usable.
 *
 * @param {string} stateFilePath
 * @returns {Promise<{ status: 'ok', items: unknown[] } | { status: 'unavailable' }>}
 */
async function readStateFile(stateFilePath) {
  let raw
  try {
    const handle = await nodeFs.promises.open(stateFilePath, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_STATE_FILE_BYTES) {
        return { status: 'unavailable' }
      }
      raw = await handle.readFile('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return { status: 'unavailable' }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { status: 'unavailable' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unavailable' }
  }
  if (!Array.isArray(parsed.items)) {
    return { status: 'unavailable' }
  }
  return { status: 'ok', items: parsed.items.slice(0, MAX_ITEMS) }
}

/**
 * Validate one snapshot entry down to a plain `{ kind, path, mediaType }`.
 * A malformed `mediaType` drops the hint rather than the item: the path stays
 * usable and the client simply treats it as unsupported.
 *
 * @param {unknown} candidate
 * @returns {{ kind: 'file' | 'directory', path: string, mediaType?: string } | undefined}
 */
function validateItem(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined
  }
  const { kind, path, mediaType } = /** @type {Record<string, unknown>} */ (candidate)
  if (kind !== 'file' && kind !== 'directory') {
    return undefined
  }
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    return undefined
  }
  if (ILLEGAL_PATH_CHARACTERS.test(path)) {
    return undefined
  }

  const validated = { kind, path }
  if (typeof mediaType === 'string' && mediaType.length <= MAX_MEDIA_TYPE_LENGTH &&
      MEDIA_TYPE_PATTERN.test(mediaType)) {
    validated.mediaType = mediaType.toLowerCase()
  }
  return validated
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS })
}

/**
 * Build the `/api/clipboard/paths` handler.
 *
 * @param {() => string | undefined} resolveStateFile
 * @returns {(request: Request) => Promise<Response>}
 */
export function createPathsRouteHandler(resolveStateFile = resolveStateFilePath) {
  return async function handlePaths(request) {
    void request

    const stateFilePath = resolveStateFile()
    if (stateFilePath === undefined) {
      // Not Windows, or LOCALAPPDATA is unavailable.
      return jsonResponse({ supported: false, truncated: false, items: [] })
    }

    const state = await readStateFile(stateFilePath)
    if (state.status !== 'ok') {
      // A missing or corrupt file means "nothing to insert", not "broken".
      return jsonResponse({ supported: true, truncated: false, items: [] })
    }

    const validated = []
    for (const candidate of state.items) {
      const item = validateItem(candidate)
      if (item !== undefined) {
        validated.push(item)
      }
    }

    // The Hook classified these paths when it created the snapshot. Do not
    // repeat filesystem metadata I/O on the paste request: a second stat of a
    // mapped drive or UNC share adds visible latency and can leave an
    // uncancellable libuv operation behind after a timeout.
    return jsonResponse({ supported: true, truncated: false, items: validated })
  }
}

/**
 * Build the `/api/clipboard/media-types` handler.
 *
 * Supported image types are a deployment fact owned by the attachments service.
 * The client needs them before deciding whether to intercept a paste, so they
 * are published separately from the snapshot.
 *
 * @param {{ imageLimits?: { mediaTypes?: readonly string[] } } | undefined} attachments
 * @returns {(request: Request) => Promise<Response>}
 */
export function createMediaTypesRouteHandler(attachments) {
  return async function handleMediaTypes(request) {
    void request
    const mediaTypes = (attachments?.imageLimits?.mediaTypes ?? [])
      .filter((value) => typeof value === 'string' && value.length <= MAX_MEDIA_TYPE_LENGTH)
      .slice(0, MAX_MEDIA_TYPES)
    return jsonResponse({ supported: true, mediaTypes })
  }
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: PATHS_ROUTE,
      methods: ['GET'],
      fetch: createPathsRouteHandler(resolveStateFilePath),
    }),
    'dsh-windows-paste-path: paths route',
  )

  ctx.effect(
    () => ctx.connection.fetch.register({
      path: MEDIA_TYPES_ROUTE,
      methods: ['GET'],
      fetch: createMediaTypesRouteHandler(ctx.attachments),
    }),
    'dsh-windows-paste-path: media-types route',
  )
}
