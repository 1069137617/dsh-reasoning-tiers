import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const SEEDS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit']

test('client bundle exists and satisfies the loader contract', () => {
  const path = join(root, 'lib/client.js')
  assert.ok(existsSync(path), 'lib/client.js missing — run npm run build:client')
  const code = readFileSync(path, 'utf8')
  assert.ok(code.startsWith('window.__ModuleLoader__.load({'), 'bundle must open with the loader registration')
  assert.ok(code.includes(`id: ${JSON.stringify(pkg.name)}`), 'bundle must register the package name byte for byte')
  const requested = [...code.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  for (const specifier of new Set(requested)) {
    assert.ok(SEEDS.includes(specifier), `bundle requires non-seed module: ${specifier}`)
  }
})
