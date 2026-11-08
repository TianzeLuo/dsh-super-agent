/**
 * attachments.test.mjs — dispatch/steer 附件：复制、路径规则、限制与 Worker 可读性。
 *
 * 用一张**真 PNG**（自己按 PNG 规范拼 IHDR/IDAT/IEND）和一个 md 文件做端到端
 * 断言：暂存副本存在、字节一致、PNG 像素能解出来、md 内容能读到；再检查
 * 相对路径基准、越界/类型/大小上限的报错，以及 dispatch/steer 真的把路径写进
 * Worker 的提示词。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

import {
  ATTACHMENT_DEFAULTS,
  AttachmentError,
  renderAttachmentNote,
  renderAttachmentsSection,
  resolveAttachmentPaths,
  stageAttachments,
} from '../lib/attachments.js'
import { RuntimeInputError } from '../lib/runtime.js'
import { fakeProject, setupRuntime, tick } from './fake-host.mjs'

// ── 最小 PNG 编码/解码（只为断言“像素可读”，不引第三方库） ─────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const kind = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([kind, data])), 0)
  return Buffer.concat([length, kind, data, crc])
}

/** 造一张 width×height 的 RGBA PNG。 */
function makePng(width, height, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // color type RGBA
  const stride = width * 4
  const rows = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    rows[y * (stride + 1)] = 0 // filter: none
    pixels.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 解出 PNG 的尺寸与像素（拒绝损坏的图）。 */
function decodePng(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
  let offset = 8
  let header
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('latin1')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9] }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  assert.ok(header, 'IHDR chunk')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * 4
  const pixels = []
  for (let y = 0; y < header.height; y += 1) {
    const start = y * (stride + 1)
    assert.equal(raw[start], 0, 'row filter')
    pixels.push(Buffer.from(raw.subarray(start + 1, start + 1 + stride)))
  }
  return { ...header, pixels }
}

/** 一张 3×2 的图：每像素颜色不同，便于断言像素顺序。 */
function sampleImage() {
  const width = 3
  const height = 2
  const pixels = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 4] = 10 + i
    pixels[i * 4 + 1] = 20 + i
    pixels[i * 4 + 2] = 30 + i
    pixels[i * 4 + 3] = 255
  }
  return { width, height, pixels, png: makePng(width, height, pixels) }
}

/** 在项目根写 fixture：一张真 png + 一个 md。 */
function writeFixtures(root) {
  const image = sampleImage()
  writeFileSync(join(root, 'screenshot.png'), image.png)
  writeFileSync(join(root, 'notes.md'), '# Notes\n\n- step one\n- step two\n')
  return image
}

// ── 暂存与可读性 ───────────────────────────────────────────────────────────

test('stages a real PNG and an md so the worker can read pixels and text', () => {
  const project = fakeProject()
  const image = writeFixtures(project.root)
  const destDir = join(project.dataDir, 'attachments', 'tsk_stage0001')
  const staged = stageAttachments({
    paths: ['screenshot.png', 'notes.md'],
    baseDir: project.root,
    destDir,
  })

  assert.equal(staged.files.length, 2)
  assert.equal(staged.dir, destDir)
  const [png, md] = staged.files
  assert.equal(png.kind, 'image')
  assert.equal(png.mediaType, 'image/png')
  assert.equal(md.kind, 'file')
  for (const file of staged.files) {
    assert.ok(existsSync(file.path), `staged copy exists: ${file.path}`)
    assert.ok(file.path.startsWith(destDir), 'copy lives in the staging dir')
  }
  assert.deepEqual(readFileSync(png.path), image.png, 'PNG bytes copied verbatim')
  const decoded = decodePng(readFileSync(png.path))
  assert.equal(decoded.width, image.width)
  assert.equal(decoded.height, image.height)
  assert.deepEqual(decoded.pixels, [image.pixels.subarray(0, 12), image.pixels.subarray(12, 24)], 'pixels readable')
  assert.equal(readFileSync(md.path, 'utf8'), readFileSync(join(project.root, 'notes.md'), 'utf8'))
  assert.match(readFileSync(md.path, 'utf8'), /step two/)

  const section = renderAttachmentsSection(staged.files)
  assert.match(section, /read_image/)
  assert.match(section, new RegExp(png.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(section, /untrusted data/)
  assert.match(renderAttachmentNote(staged.files), /Attachments staged for this message/)
  assert.equal(renderAttachmentsSection([]), '')
  assert.equal(renderAttachmentNote([]), '')
})

test('attachment paths resolve against the worker project root and reject escapes', () => {
  const project = fakeProject()
  const resolved = resolveAttachmentPaths(['notes.md', join(project.root, 'abs.png')], project.root)
  assert.equal(resolved[0], join(project.root, 'notes.md'))
  assert.equal(resolved[1], join(project.root, 'abs.png'))

  assert.throws(
    () => resolveAttachmentPaths(['../outside.md'], project.root),
    (error) => error instanceof AttachmentError && /outside the worker project root/.test(error.message),
  )
  assert.throws(() => resolveAttachmentPaths('notes.md', project.root), /must be an array/)
  assert.throws(() => resolveAttachmentPaths(['  '], project.root), /non-empty path/)
  assert.throws(
    () => resolveAttachmentPaths(Array.from({ length: ATTACHMENT_DEFAULTS.maxFiles + 1 }, () => 'notes.md'), project.root),
    /too many attachments/,
  )
  assert.throws(
    () => resolveAttachmentPaths(['a.md', 'b.md'], project.root, { maxFiles: 1 }),
    /too many attachments/,
  )
})

test('unsupported, missing, non-regular and oversized attachments fail with explicit errors', () => {
  const project = fakeProject()
  writeFixtures(project.root)
  writeFileSync(join(project.root, 'scan.bmp'), 'BM-not-really')
  writeFileSync(join(project.root, 'broken.png'), 'not a png')
  mkdirSync(join(project.root, 'folder'))
  const destDir = join(project.dataDir, 'attachments', 'tsk_errors')

  assert.throws(
    () => stageAttachments({ paths: ['missing.png'], baseDir: project.root, destDir }),
    (error) => error instanceof AttachmentError && error.code === 'attachment_not_found' && /file not found/.test(error.message),
  )
  assert.throws(
    () => stageAttachments({ paths: ['folder'], baseDir: project.root, destDir }),
    /only regular files/,
  )
  assert.throws(
    () => stageAttachments({ paths: ['scan.bmp'], baseDir: project.root, destDir }),
    (error) => error instanceof AttachmentError && error.code === 'unsupported_type' && /not supported/.test(error.message),
  )
  assert.throws(
    () => stageAttachments({ paths: ['broken.png'], baseDir: project.root, destDir }),
    /does not match the file content/,
  )
  assert.throws(
    () => stageAttachments({ paths: ['notes.md'], baseDir: project.root, destDir, limits: { maxFileBytes: 8 } }),
    /per-file limit/,
  )
  assert.throws(
    () =>
      stageAttachments({
        paths: ['notes.md', 'screenshot.png'],
        baseDir: project.root,
        destDir,
        limits: { maxTotalBytes: 8 },
      }),
    /total limit/,
  )
})

test('symlinked attachments are rejected instead of silently followed', (t) => {
  const project = fakeProject()
  writeFixtures(project.root)
  const link = join(project.root, 'link.png')
  try {
    symlinkSync(join(project.root, 'screenshot.png'), link)
  } catch {
    t.skip('symlinks are not available on this platform')
    return
  }
  assert.throws(
    () => stageAttachments({ paths: ['link.png'], baseDir: project.root, destDir: join(project.dataDir, 'attachments', 'tsk_link') }),
    /symbolic links are not supported/,
  )
})

// ── dispatch / steer 接线 ──────────────────────────────────────────────────

test('dispatch copies attachments and tells the worker the absolute copy paths', async () => {
  const ctx = setupRuntime()
  const image = writeFixtures(ctx.root)
  const dispatched = ctx.runtime.dispatch({
    title: 'Inspect the screenshot',
    brief: 'Read the attached screenshot and notes, then summarise what must change.',
    attachments: ['screenshot.png', 'notes.md'],
  })
  assert.equal(dispatched.ok, true)
  assert.equal(dispatched.attachments.length, 2)
  for (const file of dispatched.attachments) assert.ok(existsSync(file), `staged file exists: ${file}`)

  await tick()
  const spawn = ctx.subagents.spawns[0]
  const prompt = spawn.spec.request.prompt[0].text
  for (const file of dispatched.attachments) assert.match(prompt, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(prompt, /read_image/)
  assert.match(prompt, /Attachments \(read-only copies staged for this task/)
  assert.equal(prompt.includes(join(ctx.root, 'screenshot.png')), false, 'worker gets the staged copy, not the original path')

  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.attachments.length, 2)
  assert.equal(task.attachments[0].kind, 'image')
  const snapshot = ctx.runtime.status('compact')
  assert.deepEqual(snapshot.tasks[0].attachments, dispatched.attachments)

  // Worker 侧真能读：暂存副本的 md 内容与 PNG 像素。
  const stagedImage = task.attachments[0].path
  const decoded = decodePng(readFileSync(stagedImage))
  assert.equal(decoded.width, image.width)
  assert.equal(decoded.height, image.height)
  assert.deepEqual(decoded.pixels[0], image.pixels.subarray(0, 12))
  assert.match(readFileSync(task.attachments[1].path, 'utf8'), /step one/)
  ctx.runtime.stop()
})

test('steer accepts attachments and appends their paths to the message', async () => {
  const ctx = setupRuntime()
  writeFixtures(ctx.root)
  const dispatched = ctx.runtime.dispatch({ title: 'Watch the build', brief: 'Wait for the build to finish and report.' })
  await tick()
  const child = [...ctx.children.values()][0]

  const steered = ctx.runtime.steer(dispatched.taskId, 'This screenshot shows the failure.', {
    attachments: ['screenshot.png'],
  })
  assert.equal(steered.ok, true)
  assert.equal(steered.attachments.length, 1)
  assert.ok(existsSync(steered.attachments[0]))
  const last = child.messages.at(-1)
  assert.match(last.content[0].text, /This screenshot shows the failure\./)
  assert.match(last.content[0].text, /Attachments staged for this message/)
  assert.match(last.content[0].text, new RegExp(steered.attachments[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.attachments.length, 1)
  assert.equal(task.attachments[0].kind, 'image')
  ctx.runtime.stop()
})

test('a bad attachment rejects the dispatch before any task is created', () => {
  const ctx = setupRuntime()
  writeFixtures(ctx.root)
  const before = ctx.store.listTasks().length
  assert.throws(
    () => ctx.runtime.dispatch({
      title: 'Missing file',
      brief: 'This dispatch must fail because the attachment does not exist.',
      attachments: ['nope.png'],
    }),
    (error) => error instanceof RuntimeInputError && error.code === 'attachment_not_found' && /file not found/.test(error.message),
  )
  assert.equal(ctx.store.listTasks().length, before)
  assert.equal(ctx.subagents.spawns.length, 0)
  ctx.runtime.stop()
})
