const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const vm = require('node:vm')
const CLIENT_SOURCE = fs.readFileSync(new URL('../lib/client.js', `file:///${__filename.replace(/\\/g, '/')}`), 'utf8')

class FakeElement {
  constructor(attributes = {}) { this.attributes = attributes }
  getAttribute(name) { return this.attributes[name] ?? null }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
  closest() { return this.card ?? null }
  querySelector() { return this.input ?? null }
  focus() {}
  contains(target) { return target === this }
  get isConnected() { return true }
}
class FakeText {}
class FakeTextArea extends FakeElement {}
const PATH_RESPONSE = {
  supported: true,
  items: [{ kind: 'directory', path: '\\\\10.40.73.81\\data3\\udT710' }],
}

function createHarness(fetchBody = PATH_RESPONSE) {
  const input = new FakeElement({ 'data-composer-input': '', contenteditable: 'true' })
  const card = new FakeElement()
  input.card = card
  card.input = input
  const listeners = new Map()
  const fetchCalls = []
  const inserts = []
  let registration
  let dispose
  const document = {
    readyState: 'complete', activeElement: input,
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    execCommand(command, _ui, value) { inserts.push({ command, value }); return true },
  }
  const context = {
    AbortController, Element: FakeElement, Text: FakeText, HTMLTextAreaElement: FakeTextArea,
    Event: class {}, clearTimeout, setTimeout, document,
    window: { __ModuleLoader__: { load(value) { registration = value } } },
    fetch: async url => {
      fetchCalls.push(url)
      return { ok: true, json: async () => fetchBody }
    },
  }
  vm.runInNewContext(CLIENT_SOURCE, context)
  registration.factory().apply({ effect(setup) { dispose = setup() } })
  return { input, document, listeners, fetchCalls, inserts, dispose }
}

function keyEvent(target, overrides = {}) {
  const calls = { preventDefault: 0, stopPropagation: 0, stopImmediatePropagation: 0 }
  return {
    target, key: 'v', code: 'KeyV', altKey: true, ctrlKey: false,
    shiftKey: false, metaKey: false, repeat: false, isComposing: false, defaultPrevented: false,
    preventDefault() { calls.preventDefault++ },
    stopPropagation() { calls.stopPropagation++ },
    stopImmediatePropagation() { calls.stopImmediatePropagation++ },
    calls, ...overrides,
  }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test('Alt+V inserts a UNC snapshot without reading the browser clipboard', async () => {
  const h = createHarness()
  const event = keyEvent(h.input)
  Object.defineProperty(event, 'clipboardData', { get() { throw new Error('clipboard read') } })
  h.listeners.get('keydown')(event)
  await settle()
  assert.equal(event.calls.preventDefault, 1)
  assert.deepEqual(h.fetchCalls, ['/api/clipboard/paths'])
  assert.deepEqual(h.inserts, [{ command: 'insertText', value: PATH_RESPONSE.items[0].path }])
})

test('native paste is never registered and Ctrl+V never fetches or cancels', async () => {
  const h = createHarness()
  assert.deepEqual([...h.listeners.keys()], ['keydown'])
  const event = keyEvent(h.input, { ctrlKey: true, altKey: false })
  h.listeners.get('keydown')(event)
  await settle()
  assert.deepEqual(event.calls, { preventDefault: 0, stopPropagation: 0, stopImmediatePropagation: 0 })
  assert.deepEqual(h.fetchCalls, [])
  assert.deepEqual(h.inserts, [])
})

test('other chords, composition, and non-composer targets stay untouched', async () => {
  const h = createHarness()
  for (const overrides of [
    { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { isComposing: true },
    { key: 'x', code: 'KeyX' }, { getModifierState: () => true },
    { defaultPrevented: true }, { target: new FakeElement() },
  ]) {
    const event = keyEvent(h.input, overrides)
    h.listeners.get('keydown')(event)
    assert.equal(event.calls.preventDefault, 0)
  }
  await settle()
  assert.deepEqual(h.fetchCalls, [])
})

test('repeated Alt+V is consumed without another request', async () => {
  const h = createHarness()
  const event = keyEvent(h.input, { repeat: true })
  h.listeners.get('keydown')(event)
  await settle()
  assert.equal(event.calls.preventDefault, 1)
  assert.deepEqual(h.fetchCalls, [])
})

test('focus leaving the original composer cancels insertion', async () => {
  const h = createHarness()
  h.listeners.get('keydown')(keyEvent(h.input))
  h.document.activeElement = new FakeElement()
  await settle()
  assert.deepEqual(h.inserts, [])
})

test('disposal removes shortcut and invalidates pending insertion', async () => {
  const h = createHarness()
  h.listeners.get('keydown')(keyEvent(h.input))
  h.dispose()
  await settle()
  assert.equal(h.listeners.size, 0)
  assert.deepEqual(h.inserts, [])
})

test('empty snapshot never falls back to native paste', async () => {
  const h = createHarness({ supported: true, items: [] })
  h.listeners.get('keydown')(keyEvent(h.input))
  await settle()
  assert.deepEqual(h.inserts, [])
  assert.equal(h.listeners.has('paste'), false)
})
