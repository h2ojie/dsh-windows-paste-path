const assert = require('node:assert/strict')
const fs = require('node:fs')
const test = require('node:test')
const vm = require('node:vm')

const CLIENT_SOURCE = fs.readFileSync(new URL('../lib/client.js', `file:///${__filename.replace(/\\/g, '/')}`), 'utf8')

class FakeElement {
  constructor(attributes = {}) {
    this.attributes = attributes
    this.parentElement = null
  }

  getAttribute(name) { return this.attributes[name] ?? null }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name) }
  closest(selector) { return selector === '[data-composer-card]' ? this.card ?? null : null }
  querySelector() { return this.input ?? null }
  focus() {}
}

class FakeText {}
class FakeTextArea extends FakeElement {}

function clipboardData({ types = [], items = [], files = [], text = {} } = {}) {
  return {
    types,
    items,
    files,
    getData(type) { return text[type] ?? '' },
  }
}

function createHarness(fetchBody = { supported: true, items: [] }, options = {}) {
  const input = new FakeElement({ 'data-composer-input': '', contenteditable: 'true' })
  const card = new FakeElement({ 'data-composer-card': '' })
  input.card = card
  card.input = input

  const listeners = new Map()
  const fetchCalls = []
  const inserts = []
  let registration
  const document = {
    readyState: 'complete',
    activeElement: input,
    addEventListener(type, listener) { listeners.set(type, listener) },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type)
    },
    querySelector() { return input },
    execCommand(command, _ui, value) {
      inserts.push({ command, value })
      if (options.reenterPaste === true) {
        listeners.get('paste')?.(pasteEvent(clipboardData({
          types: ['Files'],
          items: [{ kind: 'file', type: '', getAsFile: () => ({ name: 'folder', type: '' }) }],
        }), input))
      }
      return true
    },
  }
  const window = {
    __ModuleLoader__: { load(value) { registration = value } },
    addEventListener() {},
    removeEventListener() {},
  }
  const fetch = async (url) => {
    fetchCalls.push(url)
    return { ok: true, json: async () => fetchBody }
  }
  const context = {
    AbortController,
    Element: FakeElement,
    Event: class {},
    HTMLTextAreaElement: FakeTextArea,
    Text: FakeText,
    clearTimeout,
    console,
    document,
    fetch,
    setTimeout,
    window,
  }
  vm.createContext(context)
  vm.runInContext(CLIENT_SOURCE, context)
  registration.factory().apply({ effect(setup) { setup() } })
  // Ignore eager media-type discovery; each assertion concerns the paste path.
  fetchCalls.length = 0
  return { fetchCalls, input, inserts, listeners }
}

function pasteEvent(data, target) {
  const calls = { preventDefault: 0, stopPropagation: 0, stopImmediatePropagation: 0 }
  return {
    ...calls,
    clipboardData: data,
    defaultPrevented: false,
    target,
    preventDefault() { calls.preventDefault += 1 },
    stopPropagation() { calls.stopPropagation += 1 },
    stopImmediatePropagation() { calls.stopImmediatePropagation += 1 },
    calls,
  }
}

function settle() {
  return new Promise(resolve => setTimeout(resolve, 0))
}

test('ordinary text that looks like a Windows path stays native', async () => {
  const harness = createHarness()
  let payloadReads = 0
  const event = pasteEvent({
    types: ['text/plain'],
    get items() { payloadReads += 1; throw new Error('ordinary text payload must not be inspected') },
    get files() { payloadReads += 1; throw new Error('ordinary text payload must not be inspected') },
    getData() { payloadReads += 1; throw new Error('ordinary text payload must not be inspected') },
  }, harness.input)

  harness.listeners.get('paste')(event)
  await settle()

  assert.deepEqual(event.calls, {
    preventDefault: 0,
    stopPropagation: 0,
    stopImmediatePropagation: 0,
  })
  assert.equal(payloadReads, 0)
  assert.deepEqual(harness.fetchCalls, [])
  assert.deepEqual(harness.inserts, [])
})

test('genuine file paste is intercepted without reading text fallback payload', async () => {
  const harness = createHarness({
    supported: true,
    items: [{ kind: 'directory', path: 'C:\\work\\folder' }],
  })
  let textReads = 0
  const event = pasteEvent({
    types: ['Files'],
    items: [{
      kind: 'file',
      type: '',
      getAsFile: () => { throw new Error('folder getAsFile must not be called') },
    }],
    get files() { throw new Error('clipboardData.files must not be read') },
    getData() { textReads += 1; throw new Error('CF_HDROP text payload must not be inspected') },
  }, harness.input)

  harness.listeners.get('paste')(event)
  await settle()
  await settle()

  assert.deepEqual(event.calls, {
    preventDefault: 1,
    stopPropagation: 1,
    stopImmediatePropagation: 1,
  })
  assert.equal(textReads, 0)
  assert.deepEqual(harness.fetchCalls, ['/api/clipboard/paths'])
  assert.deepEqual(harness.inserts, [{ command: 'insertText', value: 'C:\\work\\folder' }])
})

test('supported image paste stays with the native DSH attachment path', async () => {
  const harness = createHarness()
  const event = pasteEvent(clipboardData({
    types: ['Files'],
    items: [{
      kind: 'file',
      type: 'image/png',
      getAsFile: () => ({ name: 'image.png', type: 'image/png' }),
    }],
  }), harness.input)

  harness.listeners.get('paste')(event)
  await settle()

  assert.deepEqual(event.calls, {
    preventDefault: 0,
    stopPropagation: 0,
    stopImmediatePropagation: 0,
  })
  assert.deepEqual(harness.fetchCalls, [])
  assert.deepEqual(harness.inserts, [])
})

test('synchronous paste reentry during insertText is ignored', async () => {
  const harness = createHarness({
    supported: true,
    items: [{ kind: 'directory', path: 'C:\\work\\folder' }],
  }, { reenterPaste: true })
  const event = pasteEvent(clipboardData({
    types: ['Files'],
    items: [{ kind: 'file', type: '', getAsFile: () => ({ name: 'folder', type: '' }) }],
  }), harness.input)

  harness.listeners.get('paste')(event)
  await settle()
  await settle()

  assert.deepEqual(harness.fetchCalls, ['/api/clipboard/paths'])
  assert.deepEqual(harness.inserts, [{ command: 'insertText', value: 'C:\\work\\folder' }])
})
