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

// Admission budget for the existence recheck. Unreachable network shares can
// make a single stat() hang for tens of seconds, so the whole batch is bounded.
const TOTAL_VERIFY_BUDGET_MS = 1500
const PER_ITEM_TIMEOUT_MS = 400
const VERIFY_CONCURRENCY = 16

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

/**
 * Bound a single stat() against a timeout.
 *
 * Node's `fs.stat` has no timeout of its own and an unreachable UNC share can
 * block far longer than a paste is allowed to wait.
 *
 * @param {string} path
 * @param {number} timeoutMs
 * @returns {Promise<'directory' | 'file' | undefined>}
 */
async function statKindWithTimeout(path, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      nodeFs.promises.stat(path).then(
        (stat) => (stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : undefined),
        () => undefined,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/**
 * Recheck that every path still exists and still has the recorded kind.
 *
 * This is deliberately not a freshness check: there is no timestamp, sequence
 * number, or consumption marker. It exists so a snapshot left behind by an
 * exited hook can never surface a path that has since been deleted or retyped.
 *
 * @param {{ kind: string, path: string, mediaType?: string }[]} items
 * @returns {Promise<object[]>} confirmed items in snapshot order
 */
async function verifyItems(items) {
  const startedAt = Date.now()
  const confirmed = []

  for (let offset = 0; offset < items.length; offset += VERIFY_CONCURRENCY) {
    const remaining = TOTAL_VERIFY_BUDGET_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      break
    }
    const batch = items.slice(offset, offset + VERIFY_CONCURRENCY)
    const actualKinds = await Promise.all(
      batch.map((item) => statKindWithTimeout(item.path, Math.min(PER_ITEM_TIMEOUT_MS, remaining))),
    )
    for (let index = 0; index < batch.length; index += 1) {
      const actualKind = actualKinds[index]
      if (actualKind === undefined) {
        continue  // missing, inaccessible, or timed out: never hand it back
      }
      // The filesystem wins over the recorded kind.
      confirmed.push({ ...batch[index], kind: actualKind })
    }
  }

  return confirmed
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

    const items = await verifyItems(validated)
    return jsonResponse({ supported: true, truncated: false, items })
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
