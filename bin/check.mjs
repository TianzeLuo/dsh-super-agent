import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

for (const directory of ['lib', 'bin']) {
  const root = new URL(`../${directory}/`, import.meta.url)
  for (const file of readdirSync(root, { withFileTypes: true })) {
    if (!file.isFile() || !/\.m?js$/.test(file.name)) continue
    const checked = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(file.name, root))], { stdio: 'inherit' })
    if (checked.error) throw checked.error
    if (checked.status !== 0) process.exit(checked.status ?? 1)
  }
}
console.log('Core syntax checks passed.')
