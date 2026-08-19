// Client bundle shape check: verifies the lazy-CJS factory contract the web
// harness expects — a classic script registering window.__ModuleLoader__.load,
// whose factory returns the plugin exports ({ apply, inject }).
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./lib/client.js', import.meta.url), 'utf8')
assert.ok(source.includes('window.__ModuleLoader__.load'), 'client bundle must register a __ModuleLoader__ factory')
assert.ok(source.includes('id: "dsh-feishu"'), 'client bundle must register under the plugin id')

let entry = null
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) {
      entry = candidate
    },
  },
}

const url = new URL('./lib/client.js?smoke=' + Date.now(), import.meta.url)
await import(url)

assert.notEqual(entry, null)
assert.equal(entry.id, 'dsh-feishu')
assert.equal(typeof entry.factory, 'function')

const require = createRequire(import.meta.url)
const exports = entry.factory(require)
assert.equal(typeof exports.apply, 'function')
assert.deepEqual(exports.inject, ['slots', 'locale'])

let passed = 0
for (const name of ['factory registered', 'factory returns { apply, inject }']) {
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}
