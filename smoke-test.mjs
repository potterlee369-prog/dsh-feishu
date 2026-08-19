// Smoke test for dsh-feishu. Uses the built lib bundle and a mock host
// context, so it needs no Feishu credentials and makes no network calls:
// an invalid appId stops the Feishu WS client before it ever dials out.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  SETTINGS_ROUTE,
  apply,
  ChatQueue,
  DshBridge,
  extractReplyText,
  isPathInside,
  normalizeFeishuFileType,
  parseFileEvent,
  parseImageEvent,
  parsePostEvent,
  parseSendCommand,
  parseTextEvent,
  resolveConfig,
  resolvePrompt,
  sanitizeFileName,
  splitReply,
} from './lib/index.js'

let passed = 0
function ok(name) {
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

// ── pure helpers ────────────────────────────────────────────────────────────

{
  const config = resolveConfig(undefined)
  assert.equal(config.trigger, '@dsh')
  assert.equal(config.p2pNoTrigger, true)
  assert.equal(config.replyChunkSize, 1800)
  assert.equal(config.ack, true)
  ok('resolveConfig applies defaults (private chats skip @)')
}

{
  const parsed = parseTextEvent({
    event_id: 'evt-1',
    message: {
      message_id: 'om-1',
      chat_id: 'oc_test',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 帮我把今天的日志整理一下' }),
      mentions: [{ key: '@_user_1', name: 'dsh' }],
    },
  })
  assert.deepEqual(parsed, {
    text: '@dsh 帮我把今天的日志整理一下',
    messageId: 'om-1',
    chatId: 'oc_test',
    chatType: 'group',
  })
  ok('parseTextEvent restores group mentions')
}

{
  assert.equal(parseTextEvent({ message: { message_type: 'image', content: '{}' } }), null)
  assert.equal(parseTextEvent({ message: { message_type: 'text', content: 'not-json' } }), null)
  ok('parseTextEvent rejects non-text or malformed content')
}

{
  const parsed = parseFileEvent({
    event_id: 'evt-file-1',
    message: {
      message_id: 'om-file-1',
      chat_id: 'oc_test',
      chat_type: 'p2p',
      message_type: 'file',
      content: JSON.stringify({ file_key: 'file_v2_abc', file_name: '需求文档.docx' }),
    },
  })
  assert.deepEqual(parsed, {
    fileKey: 'file_v2_abc',
    fileName: '需求文档.docx',
    messageId: 'om-file-1',
    chatId: 'oc_test',
    chatType: 'p2p',
    mentions: undefined,
  })
  assert.equal(parseFileEvent({ message: { message_type: 'text', content: '{}' } }), null)
  assert.equal(parseFileEvent({ message: { message_type: 'file', content: 'not-json' } }), null)
  ok('parseFileEvent extracts file_key/file_name and rejects malformed events')
}

{
  assert.equal(parseSendCommand('/send report.pdf'), 'report.pdf')
  assert.equal(parseSendCommand('/发送 "reports/final report.docx"'), 'reports/final report.docx')
  assert.equal(parseSendCommand('/send'), '')
  assert.equal(parseSendCommand('send report.pdf'), null)
  assert.equal(normalizeFeishuFileType('report.pdf'), 'pdf')
  assert.equal(normalizeFeishuFileType('table.xlsx'), 'xls')
  assert.equal(normalizeFeishuFileType('archive.zip'), 'stream')
  assert.equal(sanitizeFileName('..\\private\\CON.txt'), '_CON.txt')
  assert.equal(isPathInside('C:\\workspace', 'C:\\workspace\\notes.txt'), true)
  assert.equal(isPathInside('C:\\workspace', 'C:\\other\\notes.txt'), false)
  ok('file command, upload type, filename, and workspace path helpers are safe')
}

{
  const parsed = parseImageEvent({
    event_id: 'evt-img-1',
    message: {
      message_id: 'om-img-1',
      chat_id: 'oc_test',
      chat_type: 'p2p',
      message_type: 'image',
      content: JSON.stringify({ image_key: 'img_v2_abc' }),
    },
  })
  assert.deepEqual(parsed, {
    imageKey: 'img_v2_abc',
    messageId: 'om-img-1',
    chatId: 'oc_test',
    chatType: 'p2p',
    mentions: undefined,
  })
  assert.equal(parseImageEvent({ message: { message_type: 'text', content: '{}' } }), null)
  assert.equal(parseImageEvent({ message: { message_type: 'image', content: 'not-json' } }), null)
  ok('parseImageEvent extracts image_key and rejects non-image/malformed content')
}

{
  const parsed = parsePostEvent({
    message: {
      message_id: 'om-post-1',
      chat_id: 'oc_test',
      chat_type: 'p2p',
      message_type: 'post',
      content: JSON.stringify({
        zh_cn: {
          content: [
            [{ tag: 'text', text: '看图：' }],
            [{ tag: 'img', image_key: 'img_v2_a' }],
            [{ tag: 'md', text: '**说明**' }],
          ],
        },
      }),
    },
  })
  assert.deepEqual(parsed, {
    text: '看图：\n**说明**',
    imageKeys: ['img_v2_a'],
    messageId: 'om-post-1',
    chatId: 'oc_test',
    chatType: 'p2p',
    mentions: undefined,
  })
  assert.equal(parsePostEvent({ message: { message_type: 'text', content: '{}' } }), null)
  ok('parsePostEvent extracts text and image keys from rich text')
}

{
  assert.equal(resolvePrompt('@dsh 你好', '@dsh'), '你好')
  assert.equal(resolvePrompt('  @dsh  hello ', '@dsh'), 'hello')
  assert.equal(resolvePrompt('hello', '@dsh'), null)
  assert.equal(resolvePrompt('直接说', ''), '直接说')
  assert.equal(resolvePrompt('   ', ''), null)
  ok('resolvePrompt handles trigger and empty-trigger modes')
}

{
  const events = [
    { type: 'user/message', seq: 1, data: {} },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '步骤一完成' }] } } },
    { type: 'tool/result', seq: 3, data: {} },
    { type: 'assistant/message', seq: 4, data: { message: { content: [{ type: 'text', text: '最终答复' }, { type: 'reasoning', text: '内部思考' }] } } },
  ]
  assert.equal(extractReplyText(events, 0), '最终答复')
  assert.equal(extractReplyText(events, 3), '最终答复')
  assert.equal(extractReplyText([{ type: 'assistant/message', seq: 5, data: { message: { content: [{ type: 'tool_use', name: 'bash' }] } } }], 0), '')
  ok('extractReplyText returns the final assistant text')
}

{
  const chunks = splitReply('第一段很短\n\n' + '第二段 '.repeat(100) + '\n第三段', 60)
  assert.equal(chunks.length >= 3, true)
  assert.equal(chunks.every((chunk) => chunk.length <= 60), true)
  assert.equal(chunks.join('\n').replaceAll('\n', '').length, ('第一段很短\n\n' + '第二段 '.repeat(100) + '\n第三段').replaceAll('\n', '').length)
  ok('splitReply keeps chunks under budget and preserves all text')
}

// ── per-chat serial queue ───────────────────────────────────────────────────

{
  const order = []
  const queue = new ChatQueue()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  queue.enqueue('chat-a', async () => {
    order.push('a1-start')
    await gate
    order.push('a1-end')
  })
  queue.enqueue('chat-a', () => {
    order.push('a2')
  })
  queue.enqueue('chat-b', () => {
    order.push('b1')
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ['a1-start', 'b1'])
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(order, ['a1-start', 'b1', 'a1-end', 'a2'])
  ok('ChatQueue serializes per chat and keeps chats independent')
}

// ── DshBridge against a mock host ───────────────────────────────────────────

{
  const live = new Map()
  const sessions = new Map()
  const prompts = []
  const modelSelections = []

  const makeEvents = (sessionId) => {
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { events: [{ type: 'user/message', seq: 0, data: {} }] })
    }
    return sessions.get(sessionId)
  }

  const ctx = {
    apiProxy: {
      sessions: {
        async create(request) {
          const id = request.payload.sessionId
          makeEvents(id)
          live.set(id, { id, whenIdle: async () => {} })
          return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: id } } }
        },
        async selectModel(request) {
          modelSelections.push(request.payload)
          const session = makeEvents(request.payload.sessionId)
          const lastSeq = session.events.at(-1).seq
          session.events.push({
            type: 'request/header',
            seq: lastSeq + 1,
            data: { header: { config: { provider: request.payload.provider, model: request.payload.model } } },
          })
          return {
            rpcId: request.rpcId,
            result: { ok: true, value: { selected: { provider: request.payload.provider, model: request.payload.model } } },
          }
        },
        async prompt(request) {
          prompts.push(request.payload)
          const id = request.payload.sessionId
          const session = makeEvents(id)
          const lastSeq = session.events.at(-1).seq
          session.events.push({
            type: 'assistant/message',
            seq: lastSeq + 1,
            data: { message: { content: [{ type: 'text', text: `echo:${request.payload.content[0].text}` }] } },
          })
          return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
        },
      },
      host: {
        async describe(request) {
          return {
            rpcId: request.rpcId,
            result: { ok: true, value: { provider: 'opencode-go', model: 'deepseek-v4-flash' } },
          }
        },
      },
    },
    agents: {
      get(id) {
        return live.get(id)
      },
    },
    sessions: {
      get(id) {
        return sessions.get(id)
      },
    },
  }

  const bridge = new DshBridge(ctx, resolveConfig({ cwd: 'E:\\tmp', trigger: '@dsh' }))
  const reply = await bridge.run('oc_chat_1', '整理日志')
  assert.equal(reply, 'echo:整理日志')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0].sessionId, 'feishu-oc_chat_1')
  assert.equal(prompts[0].mode, 'queue')
  assert.deepEqual(modelSelections, [{ sessionId: 'feishu-oc_chat_1', provider: 'opencode-go', model: 'deepseek-v4-flash' }])

  // Second message reuses the same DSH session (persistent context).
  const reply2 = await bridge.run('oc_chat_1', '继续')
  assert.equal(reply2, 'echo:继续')
  assert.equal(sessions.has('feishu-oc_chat_1'), true)
  assert.equal(modelSelections.length, 1)

  // /new allocates a different session id.
  const newId = bridge.newChat('oc_chat_1')
  assert.notEqual(newId, 'feishu-oc_chat_1')
  const reply3 = await bridge.run('oc_chat_1', '重来')
  assert.equal(reply3, 'echo:重来')
  assert.equal(prompts.at(-1).sessionId, newId)
  assert.equal(modelSelections.length, 2)
  ok('DshBridge creates, reuses and refreshes DSH sessions through apiProxy')
}

{
  const ctx = {
    apiProxy: {
      sessions: {
        async create(request) {
          return {
            rpcId: request.rpcId,
            result: { ok: false, error: { code: 'session-conflict', message: 'conflict', details: {} } },
          }
        },
        async prompt() {
          return { rpcId: '', result: { ok: false, error: { code: 'internal', message: 'x', details: {} } } }
        },
      },
    },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
  }
  const bridge = new DshBridge(ctx, resolveConfig(undefined))
  const reply = await bridge.run('oc_bad', 'hi')
  assert.match(reply, /无法创建 DSH 会话/)
  ok('DshBridge reports session-creation failures as chat text')
}

// ── apply() boots without credentials and disposes cleanly ──────────────────

{
  const created = []
  const effects = []
  const ctx = {
    apiProxy: {
      sessions: {
        create: async (request) => {
          created.push(request.payload)
          return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: request.payload.sessionId } } }
        },
        prompt: async (request) => ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
      },
    },
    agents: { get: () => ({ id: 'x', whenIdle: async () => {} }) },
    sessions: { get: () => undefined },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return () => {}
    },
  }
  // Invalid appId: the Feishu WS client refuses to dial, so this test is offline.
  apply(ctx, { appId: 'cli_invalid', appSecret: 'secret', trigger: '@dsh' })
  assert.equal(created.length, 0)
  assert.equal(effects.length, 1)
  effects.forEach((dispose) => dispose())
  ok('apply registers a cleanup disposer and boots offline with invalid credentials')

  // Missing credentials: apply disables the bridge without throwing.
  apply(ctx, { appId: '', appSecret: '', trigger: '@dsh' })
  ok('apply degrades gracefully without appId/appSecret')
}

// ── settings route (Settings page ↔ host settings document) ─────────────────

function mockRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name] = value
    },
    end(payload) {
      res.body = typeof payload === 'string' ? payload : payload?.toString('utf8') ?? ''
    },
  }
  return res
}

function mockReq(method, body) {
  if (body === undefined) return { method }
  return {
    method,
    on(event, callback) {
      if (event === 'data') queueMicrotask(() => callback(Buffer.from(body)))
      if (event === 'end') queueMicrotask(() => callback())
    },
  }
}

{
  let saved = { appId: '', appSecret: '', trigger: '@dsh', p2pNoTrigger: true, cwd: '', ack: true, replyChunkSize: 1800, timeoutMs: 600000 }
  const watched = []
  const scope = {
    get: () => saved,
    watch(callback) {
      watched.push(callback)
      return () => {}
    },
    async update(patch) {
      const prev = saved
      saved = { ...saved, ...patch }
      for (const callback of watched) callback(saved, prev)
    },
  }
  const routes = []
  const ctx = {
    apiProxy: {
      sessions: {
        create: async (request) => ({ rpcId: request.rpcId, result: { ok: true, value: { sessionId: request.payload.sessionId } } }),
        prompt: async (request) => ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }),
      },
    },
    agents: { get: () => ({ id: 'x', whenIdle: async () => {} }) },
    sessions: { get: () => undefined },
    settings: {
      register() {
        return scope
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: () => () => {},
  }

  apply(ctx, { appId: '', appSecret: '', trigger: '@dsh' })
  const route = routes.find((candidate) => candidate.path === SETTINGS_ROUTE)
  assert.notEqual(route, undefined)

  const getRes = mockRes()
  await route.handler(mockReq('GET'), getRes)
  const initial = JSON.parse(getRes.body)
  assert.equal(initial.ok, true)
  assert.equal(initial.writable, true)
  assert.equal(initial.config.trigger, '@dsh')
  assert.equal(initial.config.appSecret, '')

  const postRes = mockRes()
  await route.handler(
    mockReq('POST', JSON.stringify({ patch: { appId: 'cli_1234', appSecret: 's3cret', trigger: '@bot', p2pNoTrigger: false } })),
    postRes,
  )
  const updated = JSON.parse(postRes.body)
  assert.equal(updated.ok, true)
  assert.equal(updated.config.appId, 'cli_1234')
  assert.equal(updated.config.appSecret, 's3cret')
  assert.equal(updated.config.trigger, '@bot')
  assert.equal(updated.config.p2pNoTrigger, false)
  assert.equal(saved.trigger, '@bot')
  ok('settings route reads and persists the Settings page config')
}

console.log(`\n${passed} checks passed`)
