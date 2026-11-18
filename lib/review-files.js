import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_FILES = 32
const MAX_BYTES = 16 * 1024 * 1024

function inside(root, path) {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

export function snapshotReviewFiles(cwd, paths = []) {
  if (!Array.isArray(paths) || paths.length > MAX_FILES) throw new Error(`Select up to ${MAX_FILES} review files`)
  if (paths.length === 0) return []

  const directory = resolve(cwd)
  const root = realpathSync(directory)
  const files = new Map()
  let bytes = 0
  for (const name of paths) {
    if (typeof name !== 'string' || !name.trim()) throw new Error('Review files must be non-empty paths')
    // Check the resolved path as well as the input so symlinks cannot select files outside the workspace.
    const candidate = resolve(directory, name)
    if (!inside(directory, candidate)) throw new Error('Review files must be inside the task directory')
    const path = realpathSync(candidate)
    if (!inside(root, path)) throw new Error('Review files must be inside the task directory')
    const key = relative(directory, candidate)
    if (files.has(key)) continue
    if (!statSync(path).isFile()) throw new Error('Review paths must point to regular files')

    const fd = openSync(path, 'r')
    try {
      const before = fstatSync(fd)
      if (!before.isFile()) throw new Error('Review paths must point to regular files')
      bytes += before.size
      if (bytes > MAX_BYTES) throw new Error('Review files must total at most 16 MiB')
      const buffer = Buffer.allocUnsafe(before.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = readSync(fd, buffer, offset, buffer.length - offset, offset)
        if (read === 0) break
        offset += read
      }
      const after = fstatSync(fd)
      if (offset !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error('A review file changed while reading; retry when the files are settled')
      }
      files.set(key, { path: key, sha256: createHash('sha256').update(buffer.subarray(0, offset)).digest('hex') })
    } finally {
      closeSync(fd)
    }
  }
  return [...files.values()]
}
