/**
 * attachment-refs.test.mjs — P1-d 会话附件引用（`msg:`）的解析、定位与暂存。
 *
 * 宿主把聊天里的粘贴图片/上传文件存成 `user/message` 的 image/file content
 * part + attachment service 对象；这里用一个真 PNG（无扩展名的宿主对象路径）
 * 和一段 md 模拟那个结构，验证：
 *   - `msg:last` / `msg:<id>` / `:<partIndex>` 的选择与展开；
 *   - 用宿主 `imageHostPath` / `fileHostPath` 定位，并复制成 Worker 可读的
 *     带后缀副本；
 *   - 失效 id、越界 part、非附件块、缺路径、超限等错误都明确报错。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AttachmentError,
  parseAttachmentReference,
  resolveAttachmentEntries,
  stageAttachments,
} from '../lib/attachments.js'
import { RuntimeInputError } from '../lib/runtime.js'
import { setupRuntime, tick } from './fake-host.mjs'

// 2×1 RGBA PNG：左红右绿，用来断言暂存副本仍是一张可读的真图。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
  'base64',
)
const IMAGE_ID = `sha256:${'a'.repeat(64)}`
const FILE_ID = `sha256:${'b'.repeat(64)}`
const MESSAGE_ID = '3586b011-bd6f-4402-8860-d3469402f013'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-super-agent-refs-'))
  // 宿主 normalized image 的磁盘名是纯 sha256，无扩展名。
  const imagePath = join(dir, IMAGE_ID.slice('sha256:'.length))
  writeFileSync(imagePath, PNG)
  const filePath = join(dir, 'notes.md')
  writeFileSync(filePath, '# Notes\n\n- step one\n- step two\n')
  return { dir, imagePath, filePath }
}

function attachmentSource(files, messages) {
  return {
    sessionId: 'session-test',
    messages,
    imageHostPath: (ref) => (ref?.attachmentId === IMAGE_ID ? files.imagePath : undefined),
    fileHostPath: (ref) => (ref?.attachmentId === FILE_ID ? files.filePath : undefined),
  }
}

function userMessage(id = MESSAGE_ID) {
  return {
    id,
    role: 'user',
    source: { kind: 'user' },
    content: [
      {
        type: 'image',
        attachment: {
          attachmentId: IMAGE_ID,
          mediaType: 'image/png',
          width: 2,
          height: 1,
          bytes: PNG.length,
          name: 'image.png',
        },
      },
      { type: 'text', text: 'see the screenshot' },
      {
        type: 'file',
        attachment: { attachmentId: FILE_ID, name: 'notes.md', bytes: 32 },
      },
    ],
  }
}

function textMessage(id = 'trigger-1') {
  return { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'worker report arrived' }] }
}

// ── 解析规则 ───────────────────────────────────────────────────────────────

test('parseAttachmentReference separates paths from msg: selectors', () => {
  assert.deepEqual(parseAttachmentReference('/tmp/a.png'), { kind: 'path' })
  assert.deepEqual(parseAttachmentReference('C:\\Users\\me\\a.png'), { kind: 'path' })
  assert.deepEqual(parseAttachmentReference('relative/notes.md'), { kind: 'path' })
  assert.deepEqual(parseAttachmentReference('msg:last'), { kind: 'message', selector: 'last', partIndex: undefined, raw: 'msg:last' })
  assert.deepEqual(parseAttachmentReference('msg:latest'), { kind: 'message', selector: 'last', partIndex: undefined, raw: 'msg:latest' })
  assert.deepEqual(parseAttachmentReference('msg:last:2'), { kind: 'message', selector: 'last', partIndex: 2, raw: 'msg:last:2' })
  assert.deepEqual(parseAttachmentReference(`msg:${MESSAGE_ID}`), { kind: 'message', selector: MESSAGE_ID, partIndex: undefined, raw: `msg:${MESSAGE_ID}` })
  assert.deepEqual(parseAttachmentReference(`msg:${MESSAGE_ID}:0`), { kind: 'message', selector: MESSAGE_ID, partIndex: 0, raw: `msg:${MESSAGE_ID}:0` })

  for (const bad of ['msg:', 'msg:last:x', 'msg:last:-1', 'msg:last:1:2', 'msg:two words']) {
    assert.throws(
      () => parseAttachmentReference(bad),
      (error) => error instanceof AttachmentError && error.code === 'invalid_reference' && /not a valid message attachment reference|invalid part index/.test(error.message),
      bad,
    )
  }
})

test('msg:last resolves every image/file part of the latest attachment-bearing user message', () => {
  const files = fixture()
  const entries = resolveAttachmentEntries(['msg:last'], files.dir, undefined, attachmentSource(files, [userMessage(), textMessage()]))
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map((entry) => entry.kind), ['image', 'file'])
  assert.deepEqual(entries.map((entry) => entry.name), ['image.png', 'notes.md'])
  assert.deepEqual(entries.map((entry) => entry.sourceRef), ['msg:last:0', 'msg:last:2'])
  assert.equal(entries[0].path, files.imagePath)
  assert.equal(entries[0].mediaType, 'image/png')
  assert.equal(entries[1].path, files.filePath)
})

test('exact message ids and part indexes select one content block; latest skips text-only triggers', () => {
  const files = fixture()
  const source = attachmentSource(files, [userMessage(), textMessage()])
  const one = resolveAttachmentEntries([`msg:${MESSAGE_ID}:2`], files.dir, undefined, source)
  assert.equal(one.length, 1)
  assert.equal(one[0].kind, 'file')
  assert.equal(one[0].sourceRef, `msg:${MESSAGE_ID}:2`)

  const image = resolveAttachmentEntries([`msg:${MESSAGE_ID}:0`], files.dir, undefined, source)
  assert.equal(image.length, 1)
  assert.equal(image[0].kind, 'image')

  // 后面的纯文本触发不应遮住更早的用户附件消息。
  const last = resolveAttachmentEntries(['msg:last'], files.dir, undefined, source)
  assert.equal(last[0].attachmentId, IMAGE_ID)
})

test('message reference failures are explicit and never silently ignored', () => {
  const files = fixture()
  const source = attachmentSource(files, [userMessage(), textMessage()])
  const call = (ref, customSource = source) => () => resolveAttachmentEntries([ref], files.dir, undefined, customSource)

  assert.throws(
    () => resolveAttachmentEntries(['msg:last'], files.dir, undefined, null),
    (error) => error instanceof AttachmentError && error.code === 'attachment_reference_unavailable' && /live host session/.test(error.message),
  )
  assert.throws(
    call('msg:not-a-real-id'),
    (error) => error instanceof AttachmentError && error.code === 'attachment_not_found' && /no message with id "not-a-real-id"/.test(error.message) && /recent attachment messages: msg:3586b011/.test(error.message),
  )
  assert.throws(call(`msg:${MESSAGE_ID}:1`), /part 1 of message .* is a text block, not an image\/file attachment/)
  assert.throws(call(`msg:${MESSAGE_ID}:9`), /has 3 content parts \(0\.\.2\); part index 9 is out of range/)
  assert.throws(call('msg:last', attachmentSource(files, [textMessage()])), /no user message in this session has an image or file attachment/)
  assert.throws(call(`msg:${MESSAGE_ID}`, attachmentSource(files, [{ ...userMessage(), content: [{ type: 'text', text: 'no files' }] }])), /has no image\/file attachment parts/)

  const noPath = { ...source, imageHostPath: () => undefined }
  assert.throws(call(`msg:${MESSAGE_ID}:0`, noPath), /exposes no filesystem path/)

  const gone = { ...source, messages: () => { throw new Error('session store closed') } }
  assert.throws(
    call('msg:last', gone),
    (error) => error instanceof AttachmentError && error.code === 'attachment_reference_unavailable' && /could not read the current session messages.*session store closed/.test(error.message),
  )

  const unsupported = {
    ...source,
    messages: [{
      ...userMessage(),
      content: [{ type: 'image', attachment: { attachmentId: IMAGE_ID, mediaType: 'image/bmp', name: 'x.bmp' } }],
    }],
  }
  assert.throws(call(`msg:${MESSAGE_ID}:0`, unsupported), /unsupported media type image\/bmp/)

  const many = {
    ...source,
    messages: [{
      ...userMessage(),
      content: Array.from({ length: 9 }, () => ({ type: 'image', attachment: { attachmentId: IMAGE_ID, mediaType: 'image/png' } })),
    }],
  }
  assert.throws(call('msg:last', many), /too many attachments: 9; at most 8/)
})

// ── 暂存与 Worker 可读性 ───────────────────────────────────────────────────

test('staging a msg: reference gives the worker a real, correctly suffixed PNG copy', () => {
  const files = fixture()
  const destDir = join(files.dir, 'staged')
  const staged = stageAttachments({
    paths: ['msg:last'],
    baseDir: files.dir,
    destDir,
    source: attachmentSource(files, [userMessage()]),
  })
  assert.equal(staged.files.length, 2)
  const image = staged.files[0]
  assert.equal(image.kind, 'image')
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.name, 'image.png')
  assert.equal(image.sourceRef, 'msg:last:0')
  assert.ok(image.path.endsWith('image.png'), 'host object got a readable suffix')
  assert.deepEqual(readFileSync(image.path), PNG, 'bytes copied verbatim')
  // IHDR 尺寸仍可读：2×1。
  assert.equal(readFileSync(image.path).readUInt32BE(16), 2)
  assert.equal(readFileSync(image.path).readUInt32BE(20), 1)

  const text = staged.files[1]
  assert.equal(text.kind, 'file')
  assert.equal(text.name, 'notes.md')
  assert.equal(text.sourceRef, 'msg:last:2')
  assert.match(readFileSync(text.path, 'utf8'), /step two/)
})

test('a host-classified file keeps file kind even when its name looks like an image', () => {
  const files = fixture()
  const fakePng = join(files.dir, 'fake.png')
  writeFileSync(fakePng, PNG)
  const message = {
    id: 'file-only',
    role: 'user',
    content: [{ type: 'file', attachment: { attachmentId: FILE_ID, name: 'fake.png', bytes: PNG.length } }],
  }
  const source = {
    sessionId: 'session-test',
    messages: [message],
    imageHostPath: () => undefined,
    fileHostPath: () => fakePng,
  }
  const staged = stageAttachments({ paths: ['msg:last'], baseDir: files.dir, destDir: join(files.dir, 'staged-file'), source })
  assert.equal(staged.files.length, 1)
  assert.equal(staged.files[0].kind, 'file')
  assert.equal(staged.files[0].name, 'fake.png')
  assert.equal(staged.files[0].mediaType, undefined)
})

test('limits and missing host objects still apply to msg: references', () => {
  const files = fixture()
  const destDir = join(files.dir, 'staged-limits')
  assert.throws(
    () => stageAttachments({
      paths: ['msg:last'],
      baseDir: files.dir,
      destDir,
      limits: { maxFileBytes: 10 },
      source: attachmentSource(files, [userMessage()]),
    }),
    /per-file limit/,
  )
  const missing = attachmentSource({ ...files, imagePath: join(files.dir, 'gone') }, [userMessage()])
  assert.throws(
    () => stageAttachments({ paths: ['msg:last'], baseDir: files.dir, destDir, source: missing }),
    (error) => error instanceof AttachmentError && error.code === 'attachment_not_found' && /file not found/.test(error.message),
  )
})

// ── dispatch / steer 接线 ─────────────────────────────────────────────────

test('dispatch and steer accept msg: references and report the staged absolute path', async () => {
  const files = fixture()
  const messages = [userMessage()]
  const ctx = setupRuntime({ attachmentSource: attachmentSource(files, messages) })
  const dispatched = ctx.runtime.dispatch({
    title: 'Inspect the pasted screenshot',
    brief: 'Read the screenshot and the notes, then report what they contain.',
    attachments: ['msg:last'],
  })
  assert.equal(dispatched.ok, true)
  assert.equal(dispatched.attachments.length, 2)
  for (const file of dispatched.attachments) assert.ok(existsSync(file), `staged copy exists: ${file}`)
  assert.match(dispatched.attachments[0], /image\.png$/)

  await tick()
  const spawn = ctx.subagents.spawns[0]
  const prompt = spawn.spec.request.prompt[0].text
  assert.match(prompt, /read_image/)
  assert.match(prompt, /Staged from msg:last:0/)
  for (const file of dispatched.attachments) assert.match(prompt, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

  const task = ctx.store.getTask(dispatched.taskId)
  assert.equal(task.attachments.length, 2)
  assert.equal(task.attachments[0].kind, 'image')
  assert.equal(task.attachments[0].sourceRef, 'msg:last:0')

  const steered = ctx.runtime.steer(dispatched.taskId, 'This is the same screenshot again.', { attachments: ['msg:last:0'] })
  assert.equal(steered.ok, true)
  assert.equal(steered.attachments.length, 1)
  assert.ok(existsSync(steered.attachments[0]))
  assert.match(ctx.children.get(task.workerSessionId).messages.at(-1).content[0].text, /staged for this message/)
  ctx.runtime.stop()
})

test('an invalid msg: reference rejects the dispatch before any task is created', () => {
  const files = fixture()
  const ctx = setupRuntime({ attachmentSource: attachmentSource(files, [userMessage()]) })
  const before = ctx.store.listTasks().length
  assert.throws(
    () => ctx.runtime.dispatch({
      title: 'Broken reference',
      brief: 'This dispatch must fail before creating a task.',
      attachments: ['msg:does-not-exist'],
    }),
    (error) => error instanceof RuntimeInputError && error.code === 'attachment_not_found' && /no message with id/.test(error.message),
  )
  assert.equal(ctx.store.listTasks().length, before)
  assert.equal(ctx.subagents.spawns.length, 0)
  ctx.runtime.stop()
})

test('without an attachment source a msg: reference fails while absolute paths still work', async () => {
  const files = fixture()
  const ctx = setupRuntime()
  const before = ctx.store.listTasks().length
  assert.throws(
    () => ctx.runtime.dispatch({
      title: 'No source',
      brief: 'A msg: reference needs the host attachment bridge.',
      attachments: ['msg:last'],
    }),
    (error) => error instanceof RuntimeInputError && error.code === 'attachment_reference_unavailable' && /live host session/.test(error.message),
  )
  assert.equal(ctx.store.listTasks().length, before)

  const dispatched = ctx.runtime.dispatch({
    title: 'Absolute path still works',
    brief: 'Backward compatibility for the old absolute-path form.',
    attachments: [files.imagePath],
  })
  assert.equal(dispatched.ok, true)
  assert.equal(dispatched.attachments.length, 1)
  assert.ok(existsSync(dispatched.attachments[0]))
  await tick()
  ctx.runtime.stop()
})
