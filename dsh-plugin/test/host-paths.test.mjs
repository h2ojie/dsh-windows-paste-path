import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPathsRouteHandler } from '../lib/index.js'

async function snapshot(items) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-windows-paste-path-'))
  const file = join(root, 'clipboard-paths.json')
  await mkdir(root, { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, truncated: false, items }), 'utf8')
  return file
}

test('paths route returns validated hook snapshot without filesystem restat', async () => {
  const missing = join(tmpdir(), `does-not-exist-${Date.now()}`, 'folder')
  const file = await snapshot([{ kind: 'directory', path: missing }])
  const handler = createPathsRouteHandler(() => file)

  const response = await handler(new Request('http://dsh.invalid/api/clipboard/paths'))

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    supported: true,
    truncated: false,
    items: [{ kind: 'directory', path: missing }],
  })
})

test('paths route still rejects malformed entries', async () => {
  const file = await snapshot([
    { kind: 'directory', path: 'C:\\valid' },
    { kind: 'other', path: 'C:\\bad-kind' },
    { kind: 'file', path: 'C:\\bad\npath' },
  ])
  const handler = createPathsRouteHandler(() => file)
  const response = await handler(new Request('http://dsh.invalid/api/clipboard/paths'))

  assert.deepEqual((await response.json()).items, [{ kind: 'directory', path: 'C:\\valid' }])
})
