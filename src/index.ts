// Host plugin: Feishu (Lark) bridge for DSH.
//
// The plugin starts a Feishu long-connection (WebSocket) event client. When a
// message arrives in a bot chat (single chat or a group where the bot was
// mentioned) and starts with the configured trigger (default `@dsh`), the
// plugin submits it as a user prompt to a dedicated DSH session — one DSH
// session per Feishu chat, created through the host ApiProxy exactly like the
// web composer does. It then waits for the agent to go idle and sends the
// assembled assistant text back to the same Feishu chat, so the phone and PC
// Feishu clients both show the reply.
//
// Config (host-side, cordis.patch.yml):
//
//   - id: feishu
//     name: dsh-feishu
//     config:
//       appId: cli_xxxxxxxxxxxxxxxx      # Feishu app id
//       appSecret: xxxxxxxx              # Feishu app secret
//       trigger: '@dsh'                  # message prefix that activates DSH
//       cwd: ''                          # workspace dir for DSH sessions
//       agentPreset: ''                  # optional agent preset id
//       ack: true                        # send "processing" first
//       replyChunkSize: 1800             # long replies are split
//       timeoutMs: 600000                # wait-for-idle cap
//
// App credentials may also come from DSH_FEISHU_APP_ID / DSH_FEISHU_APP_SECRET.
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import * as lark from '@larksuiteoapi/node-sdk'

export const name = 'feishu'

/** Host settings namespace id used by the Settings page section. */
export const SETTINGS_NAMESPACE = settingsNamespace('feishu')

/** HTTP path the browser half loads and saves the plugin settings from. */
export const SETTINGS_ROUTE = '/plugin/dsh-feishu/settings'

/** Local end-to-end test hook: injects a synthetic Feishu event and captures the replies. */
export const SIMULATE_ROUTE = '/plugin/dsh-feishu/simulate'

export const Config = z.object({
  /** Feishu app id (`cli_...`). Falls back to env DSH_FEISHU_APP_ID. */
  appId: z.string().default(''),
  /** Feishu app secret. Falls back to env DSH_FEISHU_APP_SECRET. */
  appSecret: z.string().default(''),
  /** Message prefix that activates DSH. Empty string = every text message in the chat. */
  trigger: z.string().default('@dsh'),
  /** Private (p2p) chats ignore the trigger and activate on every text message. */
  p2pNoTrigger: z.boolean().default(true),
  /** Working directory for the DSH sessions this bridge creates. Empty = host default. */
  cwd: z.string().default(''),
  /** Optional agent preset id for the bridge's DSH sessions. */
  agentPreset: z.string().default(''),
  /** Send a short "processing" acknowledgement before running DSH. */
  ack: z.boolean().default(true),
  /** Character budget per Feishu text message; long replies are split near paragraph boundaries. */
  replyChunkSize: z.number().min(100).max(4000).default(1800),
  /** How long to wait for the DSH agent to go idle before answering "still running". */
  timeoutMs: z.number().min(5000).max(3600000).default(600000),
})

export interface FeishuConfig {
  appId: string
  appSecret: string
  trigger: string
  p2pNoTrigger: boolean
  cwd: string
  agentPreset: string
  ack: boolean
  replyChunkSize: number
  timeoutMs: number
}

/** One DSH prompt content part. Images are base64 wire parts (same as the web composer). */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

export const inject = ['apiProxy', 'agents', 'sessions', 'settings', 'webServer']

// ── minimal structural faces of the host services we consume ───────────────

type RpcResult<T> = {
  ok: true
  value: T
} | {
  ok: false
  error: {
    code: string
    message: string
    details?: unknown
  }
}

interface RpcResponse<T> {
  rpcId: string
  result: RpcResult<T>
}

interface ModelSelectionLike {
  provider: string
  model: string
  reasoningEffort?: string
}

interface HostApiLike {
  describe(request: {
    rpcId: string
    payload: Record<string, never>
  }): Promise<RpcResponse<{
    provider?: string
    model?: string
  }>>
}

interface SessionsApiLike {
  create(request: {
    rpcId: string
    payload: {
      workspaceId?: string
      cwd?: string
      sessionId?: string
      agentPreset?: string
    }
  }): Promise<RpcResponse<{ sessionId: string; agentPreset?: string }>>
  selectModel?(request: {
    rpcId: string
    payload: {
      sessionId: string
      provider: string
      model: string
      reasoningEffort?: string
    }
  }): Promise<RpcResponse<{ selected: ModelSelectionLike }>>
  prompt(request: {
    rpcId: string
    payload: {
      sessionId: string
      mode: 'queue' | 'steer'
      content: PromptContentPart[]
    }
  }): Promise<RpcResponse<{ accepted: true; command?: { kind: 'success'; text?: string } }>>
}

interface ApiProxyLike {
  sessions: SessionsApiLike
  host?: HostApiLike
}

interface AgentLike {
  id: string
  status?: 'idle' | 'running'
  whenIdle(): Promise<void>
}

interface AgentsLike {
  get(id: string): AgentLike | undefined
}

interface SessionEventLike {
  type: string
  seq: number
  data?: unknown
}

function latestSessionModel(events: readonly SessionEventLike[]): ModelSelectionLike | undefined {
  let selection: ModelSelectionLike | undefined
  for (const event of events) {
    if (event.type !== 'request/header') continue
    const data = event.data as {
      header?: {
        config?: {
          provider?: unknown
          model?: unknown
          reasoningEffort?: unknown
        }
      }
    } | undefined
    const config = data?.header?.config
    if (typeof config?.provider !== 'string' || typeof config.model !== 'string') continue
    selection = {
      provider: config.provider,
      model: config.model,
      ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  }
  return selection
}

interface SessionLike {
  events: readonly SessionEventLike[]
  header?: { cwd?: string }
}

interface SessionsLike {
  get(id: string): SessionLike | undefined
}

interface LoggerLike {
  info?(format: string, ...args: unknown[]): void
  warn?(format: string, ...args: unknown[]): void
  error?(format: string, ...args: unknown[]): void
}

interface SettingsScopeLike {
  get(): unknown
  watch(callback: (next: unknown, prev: unknown) => void): () => void
  update(patch: Record<string, unknown>): Promise<void>
}

interface SettingsProviderLike {
  register(ns: ReturnType<typeof settingsNamespace>, schema: typeof Config, options?: { base?: unknown }): SettingsScopeLike
}

interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: RouteRequest, res: RouteResponse) => void | Promise<void>
}

interface RouteRequest {
  method?: string
  url?: string
  on?(event: 'data', callback: (chunk: Buffer) => void): void
  on?(event: 'end', callback: () => void): void
  on?(event: 'error', callback: (error: Error) => void): void
}

interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: Buffer | string): void
}

interface WebServerLike {
  register(route: WebRoute): () => void
}

export interface HostContext {
  apiProxy: ApiProxyLike
  agents: AgentsLike
  sessions: SessionsLike
  settings?: SettingsProviderLike
  webServer?: WebServerLike
  logger?: LoggerLike
  effect?(callback: () => (() => void) | void, label?: string): unknown
}

// ── config resolution ───────────────────────────────────────────────────────

export function resolveConfig(config: unknown): FeishuConfig {
  const source = typeof config === 'object' && config !== null ? config as Record<string, unknown> : {}
  const pick = <K extends keyof FeishuConfig>(key: K, fallback: FeishuConfig[K]): FeishuConfig[K] => {
    const value = source[key]
    return value === undefined || value === null ? fallback : value as FeishuConfig[K]
  }
  return {
    appId: typeof source.appId === 'string' ? source.appId : '',
    appSecret: typeof source.appSecret === 'string' ? source.appSecret : '',
    trigger: pick('trigger', '@dsh'),
    p2pNoTrigger: typeof source.p2pNoTrigger === 'boolean' ? source.p2pNoTrigger : true,
    cwd: pick('cwd', ''),
    agentPreset: pick('agentPreset', ''),
    ack: typeof source.ack === 'boolean' ? source.ack : true,
    replyChunkSize: typeof source.replyChunkSize === 'number' && Number.isFinite(source.replyChunkSize)
      ? Math.min(4000, Math.max(100, Math.floor(source.replyChunkSize)))
      : 1800,
    timeoutMs: typeof source.timeoutMs === 'number' && Number.isFinite(source.timeoutMs)
      ? Math.min(3600000, Math.max(5000, Math.floor(source.timeoutMs)))
      : 600000,
  }
}

function maskAppId(appId: string): string {
  if (appId.length <= 10) return appId
  return `${appId.slice(0, 8)}…`
}

const DEBUG_LOG = process.env.DSH_FEISHU_DEBUG_LOG ?? 'C:/Users/Administrator/.dsh/feishu-debug.log'
function debugLog(line: string): void {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // debug logging must never break the bridge
  }
}

// ── pure message helpers (exported for smoke tests) ─────────────────────────

export interface FeishuMentionLike {
  key: string
  name: string
}

export interface FeishuTextEventLike {
  event_id?: string
  sender?: { sender_id?: { open_id?: string; union_id?: string; user_id?: string }; sender_type?: string }
  message: {
    message_id: string
    chat_id: string
    chat_type: string
    message_type: string
    content: string
    mentions?: FeishuMentionLike[]
  }
}

/** Parse a Feishu text message's content JSON and restore @mentions into plain text. */
export function parseTextEvent(event: FeishuTextEventLike): { text: string; messageId: string; chatId: string; chatType: string } | null {
  if (event.message.message_type !== 'text') return null
  let text: string
  try {
    const parsed = JSON.parse(event.message.content) as { text?: unknown }
    text = typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return null
  }
  for (const mention of event.message.mentions ?? []) {
    if (typeof mention.key === 'string' && mention.key !== '') text = text.replaceAll(mention.key, `@${mention.name}`)
  }
  return { text, messageId: event.message.message_id, chatId: event.message.chat_id, chatType: event.message.chat_type }
}

/** Parse a Feishu image message's content JSON and expose the resource key. */
export function parseImageEvent(event: FeishuTextEventLike): {
  imageKey: string
  messageId: string
  chatId: string
  chatType: string
  mentions?: FeishuMentionLike[]
} | null {
  if (event.message.message_type !== 'image') return null
  let imageKey: string
  try {
    const parsed = JSON.parse(event.message.content) as { image_key?: unknown }
    imageKey = typeof parsed.image_key === 'string' ? parsed.image_key : ''
  } catch {
    return null
  }
  if (imageKey === '') return null
  return {
    imageKey,
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    mentions: event.message.mentions,
  }
}

/** Parse a Feishu file message and expose the resource key and display name. */
export function parseFileEvent(event: FeishuTextEventLike): {
  fileKey: string
  fileName: string
  messageId: string
  chatId: string
  chatType: string
  mentions?: FeishuMentionLike[]
} | null {
  if (event.message.message_type !== 'file') return null
  let parsed: { file_key?: unknown; file_name?: unknown }
  try {
    parsed = JSON.parse(event.message.content) as { file_key?: unknown; file_name?: unknown }
  } catch {
    return null
  }
  const fileKey = typeof parsed.file_key === 'string' ? parsed.file_key.trim() : ''
  if (fileKey === '') return null
  const fileName = typeof parsed.file_name === 'string' && parsed.file_name.trim() !== ''
    ? parsed.file_name.trim()
    : 'feishu-file'
  return {
    fileKey,
    fileName,
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    mentions: event.message.mentions,
  }
}

/** Parse a Feishu rich-text (post) message: collect text and image keys. */
export function parsePostEvent(event: FeishuTextEventLike): {
  text: string
  imageKeys: string[]
  messageId: string
  chatId: string
  chatType: string
  mentions?: FeishuMentionLike[]
} | null {
  if (event.message.message_type !== 'post') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(event.message.content)
  } catch {
    return null
  }
  const texts: string[] = []
  const imageKeys: string[] = []
  const seenImageKeys = new Set<string>()
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item)
      return
    }
    if (typeof node !== 'object' || node === null) return
    const obj = node as Record<string, unknown>
    const tag = obj.tag
    if (tag === 'text' || tag === 'md') {
      if (typeof obj.text === 'string' && obj.text.trim() !== '') texts.push(obj.text.trim())
    } else if (tag === 'img') {
      if (typeof obj.image_key === 'string' && obj.image_key !== '' && !seenImageKeys.has(obj.image_key)) {
        seenImageKeys.add(obj.image_key)
        imageKeys.push(obj.image_key)
      }
    }
    for (const value of Object.values(obj)) visit(value)
  }
  visit(parsed)
  // Deduplicate identical adjacent text lines (rich text can repeat the same
  // text in both `content` and `content_v2` or across language blocks).
  const uniqueTexts: string[] = []
  for (const text of texts) {
    if (uniqueTexts.length === 0 || uniqueTexts[uniqueTexts.length - 1] !== text) uniqueTexts.push(text)
  }
  if (imageKeys.length === 0 && uniqueTexts.join('\n').trim() === '') return null
  return {
    text: uniqueTexts.join('\n').trim(),
    imageKeys,
    messageId: event.message.message_id,
    chatId: event.message.chat_id,
    chatType: event.message.chat_type,
    mentions: event.message.mentions,
  }
}

/** Whether a group image event mentioned the bot, based on the configured @trigger. */
function isBotMentioned(mentions: readonly FeishuMentionLike[], trigger: string): boolean {
  if (trigger === '') return true
  const botName = trigger.startsWith('@') ? trigger.slice(1).trim() : ''
  if (botName === '') return mentions.length > 0
  const normalized = botName.toLowerCase()
  return mentions.some((mention) => mention.name.toLowerCase().includes(normalized))
}

/** Strip the trigger prefix. Returns null when the message does not activate the bridge. */
export function resolvePrompt(text: string, trigger: string): string | null {
  const trimmed = text.trim()
  if (trigger === '') return trimmed === '' ? null : trimmed
  if (!trimmed.startsWith(trigger)) return null
  return trimmed.slice(trigger.length).trim()
}

/** Collect the newest non-empty assistant text produced after `sinceSeq`. */
export function extractReplyText(events: readonly SessionEventLike[], sinceSeq: number): string {
  const seen: string[] = []
  for (const event of events) {
    if (event.seq <= sinceSeq) continue
    if (event.type !== 'assistant/message') continue
    const data = event.data as { message?: { content?: readonly ({ type?: string; text?: string })[] } } | undefined
    const content = data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text !== '') seen.push(text)
  }
  // The final assistant message of a turn is the summary after any tool use;
  // fall back to concatenating every new assistant text when the last step
  // produced none (e.g. a pure tool-call step).
  return seen.length > 0 ? seen[seen.length - 1] : ''
}

/** Split a long reply near paragraph boundaries, hard-wrapping oversized paragraphs. */
export function splitReply(text: string, chunkSize: number): string[] {
  const budget = Math.max(1, Math.floor(chunkSize))
  const paragraphs = text.split(/\r?\n/)
  const chunks: string[] = []
  let current = ''
  const flush = () => {
    if (current.trim() !== '') {
      chunks.push(current.trimEnd())
      current = ''
    }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length <= budget) {
      if ((current + (current === '' ? '' : '\n') + paragraph).length > budget) flush()
      current += (current === '' ? '' : '\n') + paragraph
      continue
    }
    flush()
    let rest = paragraph
    while (rest.length > budget) {
      chunks.push(rest.slice(0, budget))
      rest = rest.slice(budget)
    }
    current = rest
  }
  flush()
  return chunks.length > 0 ? chunks : [text]
}

// ── per-chat serial queue ───────────────────────────────────────────────────

export class ChatQueue {
  private tails = new Map<string, Promise<void>>()

  enqueue(chatId: string, task: () => Promise<void> | void): void {
    const previous = this.tails.get(chatId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.tails.set(chatId, next)
    void next.finally(() => {
      if (this.tails.get(chatId) === next) this.tails.delete(chatId)
    })
  }

  size(): number {
    return this.tails.size
  }

  /** Resolve when every task currently queued for this chat has settled. */
  whenIdle(chatId: string): Promise<void> {
    return (this.tails.get(chatId) ?? Promise.resolve()).catch(() => {})
  }
}

// ── DSH session bridge ──────────────────────────────────────────────────────

const SESSION_ID_PREFIX = 'feishu-'

export class DshBridge {  private sessionIds = new Map<string, string>()
  private sessionSeq = 0

  constructor(
    private readonly ctx: HostContext,
    private readonly config: FeishuConfig,
  ) {}

  sessionCount(): number {
    return this.sessionIds.size
  }

  /** Start a fresh DSH session for this chat next time a prompt arrives. */
  newChat(chatId: string): string {
    this.sessionSeq += 1
    const id = `${SESSION_ID_PREFIX}${sanitizeSessionId(chatId)}-s${this.sessionSeq}`
    this.sessionIds.set(chatId, id)
    return id
  }

  async run(chatId: string, prompt: string): Promise<string> {
    return this.runContent(chatId, [{ type: 'text', text: prompt }])
  }

  async runContent(chatId: string, content: PromptContentPart[]): Promise<string> {
    const ensured = await this.ensureSession(chatId)
    if (!ensured.ok) return ensured.error
    const sessionId = ensured.id
    const session = this.ctx.sessions.get(sessionId)
    const sinceSeq = session?.events.length ? session.events[session.events.length - 1].seq : -1

    const promptResponse = await this.ctx.apiProxy.sessions.prompt({
      rpcId: randomUUID(),
      payload: {
        sessionId,
        mode: 'queue',
        content,
      },
    })
    if (!promptResponse.result.ok) {
      return `DSH 未受理: ${promptResponse.result.error.message} (${promptResponse.result.error.code})`
    }

    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return 'DSH 会话没有活动的 agent（可能刚被回收），请重试。'

    const idle = await withTimeout(agent.whenIdle(), this.config.timeoutMs)
    if (!idle) {
      return `DSH 仍在处理中（已超过 ${Math.round(this.config.timeoutMs / 60000)} 分钟），完成后请在 DSH 中查看结果。`
    }

    const fresh = this.ctx.sessions.get(sessionId)
    if (fresh === undefined) return 'DSH 处理完成，但会话已不在内存中，无法读取回复。'
    const reply = extractReplyText(fresh.events, sinceSeq)
    if (reply !== '') return reply

    // No assistant text: report how the turn ended instead of staying silent.
    const turnReason = lastTurnReason(fresh.events, sinceSeq)
    return turnReason === null
      ? 'DSH 完成了这一轮，但没有产出文本回复（可能只有工具调用）。'
      : `DSH 完成了这一轮（结束原因: ${turnReason}），但没有产出文本回复。`
  }

  /** Resolve the real workspace used by a Feishu chat's DSH session. */
  async workspaceDir(chatId: string): Promise<{ ok: true; id: string; dir: string } | { ok: false; error: string }> {
    const ensured = await this.ensureSession(chatId)
    if (!ensured.ok) return ensured
    const session = this.ctx.sessions.get(ensured.id)
    const sessionCwd = session?.header?.cwd?.trim() ?? ''
    const configuredCwd = this.config.cwd.trim()
    const dir = sessionCwd || configuredCwd || process.cwd()
    return { ok: true, id: ensured.id, dir: resolve(dir) }
  }

  private async ensureSession(chatId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const remembered = this.sessionIds.get(chatId)
    if (remembered !== undefined) {
      const live = this.ctx.sessions.get(remembered)
      if (live !== undefined) return this.ensureDefaultModel(remembered)
      // A remembered id with no live session is either a freshly allocated
      // /new id or a cold persisted session — create() resumes both.
      const created = await this.createSession(remembered)
      if (created.ok) return this.ensureDefaultModel(created.id)
    }

    const sessionId = `${SESSION_ID_PREFIX}${sanitizeSessionId(chatId)}`
    const created = await this.createSession(sessionId)
    if (created.ok) {
      this.sessionIds.set(chatId, created.id)
      return this.ensureDefaultModel(created.id)
    }
    return created
  }

  /** Keep Feishu sessions aligned with the host's current default model. */
  private async ensureDefaultModel(sessionId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const host = this.ctx.apiProxy.host
    const selectModel = this.ctx.apiProxy.sessions.selectModel
    if (host?.describe === undefined || selectModel === undefined) return { ok: true, id: sessionId }

    try {
      const defaultResponse = await host.describe({
        rpcId: randomUUID(),
        payload: {},
      })
      if (!defaultResponse.result.ok) {
        return {
          ok: false,
          error: `无法读取 DSH 默认模型: ${defaultResponse.result.error.message} (${defaultResponse.result.error.code})`,
        }
      }
      const provider = defaultResponse.result.value.provider?.trim() ?? ''
      const model = defaultResponse.result.value.model?.trim() ?? ''
      if (provider === '' || model === '') return { ok: true, id: sessionId }

      const session = this.ctx.sessions.get(sessionId)
      const current = latestSessionModel(session?.events ?? [])
      if (current?.provider === provider && current.model === model) return { ok: true, id: sessionId }

      const selectedResponse = await selectModel({
        rpcId: randomUUID(),
        payload: { sessionId, provider, model },
      })
      if (!selectedResponse.result.ok) {
        if (selectedResponse.result.error.code === 'model-unavailable' && selectedResponse.result.error.message.includes('image input')) {
          return {
            ok: false,
            error: `当前飞书会话包含图片，默认模型 ${provider}/${model} 不支持图片输入，请发送 /new（或 /reset）开启新会话后重试。`,
          }
        }
        return {
          ok: false,
          error: `无法切换到 DSH 默认模型 ${provider}/${model}: ${selectedResponse.result.error.message} (${selectedResponse.result.error.code})`,
        }
      }
      this.ctx.logger?.info?.('feishu: session %s uses host default model %s/%s', sessionId, provider, model)
      return { ok: true, id: sessionId }
    } catch (error) {
      return { ok: false, error: `无法同步 DSH 默认模型: ${describe(error)}` }
    }
  }

  private async createSession(sessionId: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const payload: { sessionId: string; cwd?: string; agentPreset?: string } = { sessionId }
    const cwd = this.config.cwd.trim()
    if (cwd !== '') payload.cwd = cwd
    const preset = this.config.agentPreset.trim()
    if (preset !== '') payload.agentPreset = preset

    const response = await this.ctx.apiProxy.sessions.create({
      rpcId: randomUUID(),
      payload,
    })
    if (!response.result.ok) {
      return {
        ok: false,
        error: `无法创建 DSH 会话: ${response.result.error.message} (${response.result.error.code})`,
      }
    }
    return { ok: true, id: response.result.value.sessionId }
  }
}

function sanitizeSessionId(chatId: string): string {
  const clean = chatId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^[-]+|[-]+$/g, '')
  return clean === '' ? randomUUID().slice(0, 8) : clean.slice(0, 60)
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    promise.then(
      () => {
        clearTimeout(timer)
        resolvePromise(true)
      },
      () => {
        clearTimeout(timer)
        resolvePromise(false)
      },
    )
  })
}

function lastTurnReason(events: readonly SessionEventLike[], sinceSeq: number): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.seq <= sinceSeq) break
    if (event.type !== 'turn/end') continue
    const reason = (event.data as {
      reason?: {
        kind?: string
        message?: string
        failure?: { message?: string }
        error?: { message?: string }
      }
    } | undefined)?.reason
    if (reason?.kind === undefined) return null
    const detail = reason.failure?.message ?? reason.error?.message ?? reason.message ?? ''
    return detail === '' ? reason.kind : `${reason.kind}: ${detail}`
  }
  return null
}

// ── Feishu long-connection client ───────────────────────────────────────────

type FeishuReceiveEvent = Parameters<NonNullable<lark.EventHandles['im.message.receive_v1']>>[0]

export type FeishuSend = (text: string) => Promise<void>

const FEISHU_MAX_MESSAGE_RESOURCE_BYTES = 100 * 1024 * 1024
const FEISHU_MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const FEISHU_INBOX_DIR = '.feishu-inbox'

class FeishuBridge {
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private readonly dispatcher: lark.EventDispatcher
  private readonly recentEventIds = new Set<string>()
  private stopped = false
  private ready = false

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly onMessage: (event: FeishuTextEventLike) => void,
    private readonly logger: LoggerLike | undefined,
  ) {
    this.client = new lark.Client({
      appId,
      appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
      source: 'dsh-feishu',
    })
    this.dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.info })
    this.dispatcher.register({
      'im.message.receive_v1': (data: FeishuReceiveEvent) => {
        void this.handleEvent(data as unknown as FeishuTextEventLike)
      },
    })
    this.ws = new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
      source: 'dsh-feishu',
      autoReconnect: true,
      onReady: () => {
        this.ready = true
        this.logger?.info?.('feishu: long connection ready (%s)', maskAppId(appId))
      },
      onReconnecting: () => {
        this.logger?.warn?.('feishu: long connection lost, reconnecting…')
      },
      onReconnected: () => {
        this.ready = true
        this.logger?.info?.('feishu: long connection reconnected')
      },
      onError: (error) => {
        this.ready = false
        this.logger?.error?.('feishu: long connection failed: %s', error instanceof Error ? error.message : String(error))
      },
    })
  }

  start(): void {
    void this.ws.start({ eventDispatcher: this.dispatcher })
  }

  close(): void {
    this.stopped = true
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }

  isReady(): boolean {
    return this.ready && !this.stopped
  }

  private async handleEvent(event: FeishuTextEventLike): Promise<void> {
    if (this.stopped) return
    const id = event.event_id ?? event.message?.message_id ?? ''
    this.logger?.info?.(
      'feishu: event received id=%s chat=%s type=%s text=%s',
      id || '?',
      event.message?.chat_id ?? '?',
      event.message?.message_type ?? '?',
      excerpt(event.message?.content ?? ''),
    )
    if (id !== '') {
      if (this.recentEventIds.has(id)) return
      this.recentEventIds.add(id)
      if (this.recentEventIds.size > 10000) {
        const oldest = this.recentEventIds.values().next().value
        if (typeof oldest === 'string') this.recentEventIds.delete(oldest)
      }
    }
    this.onMessage(event)
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
        uuid: randomUUID(),
      },
    })
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书发送失败: ${response.msg ?? `code ${response.code}`}`)
    }
  }

  /** Upload a local buffer and send it as a file message to a chat. */
  async sendFile(chatId: string, data: Buffer, fileName: string): Promise<void> {
    if (data.length === 0) throw new Error('不能发送空文件')
    if (data.length > FEISHU_MAX_UPLOAD_BYTES) {
      throw new Error(`文件超过飞书机器人单文件 30 MB 限制（当前 ${formatBytes(data.length)}）`)
    }
    const uploaded = await this.client.im.file.create({
      data: {
        file_type: normalizeFeishuFileType(fileName),
        file_name: fileName,
        file: data,
      },
    })
    const fileKey = uploaded?.file_key?.trim() ?? ''
    if (fileKey === '') throw new Error('飞书文件上传成功但没有返回 file_key')
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
        uuid: randomUUID(),
      },
    })
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`飞书文件消息发送失败: ${response.msg ?? `code ${response.code}`}`)
    }
  }

  async sendChunks(chatId: string, text: string, chunkSize: number): Promise<void> {
    for (const chunk of splitReply(text, chunkSize)) {
      await this.sendText(chatId, chunk)
      // Feishu group send limit is 5 QPS per bot; stay comfortably below it.
      await sleep(250)
    }
  }

  /** Download a user-sent image from a Feishu message and return base64 wire data. */
  async downloadImage(messageId: string, fileKey: string): Promise<{ data: string; mediaType: string }> {
    const response = await this.client.im.v1.messageResource.get({
      params: { type: 'image' },
      path: { message_id: messageId, file_key: fileKey },
    })
    const contentType = String(response.headers?.['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const mediaType = normalizeImageMediaType(contentType)
    const data = await readFeishuStream(response, FEISHU_MAX_MESSAGE_RESOURCE_BYTES)
    return { data: data.toString('base64'), mediaType }
  }

  /** Download a user-sent generic file from a Feishu message. */
  async downloadFile(messageId: string, fileKey: string): Promise<{ data: Buffer; contentType: string }> {
    const response = await this.client.im.v1.messageResource.get({
      params: { type: 'file' },
      path: { message_id: messageId, file_key: fileKey },
    })
    const contentType = String(response.headers?.['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const data = await readFeishuStream(response, FEISHU_MAX_MESSAGE_RESOURCE_BYTES)
    return { data, contentType }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** Map Feishu's Content-Type to the base64 image wire types accepted by DSH prompts. */
function normalizeImageMediaType(contentType: string): string {
  const normalized = contentType.toLowerCase()
  if (normalized === 'image/jpg' || normalized === 'image/jpeg') return 'image/jpeg'
  if (normalized === 'image/png') return 'image/png'
  if (normalized === 'image/webp') return 'image/webp'
  if (normalized === 'image/gif') return 'image/gif'
  throw new Error(`不支持的图片类型: ${contentType || 'unknown'}`)
}

type FeishuFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'

/** Map a filename to the file_type enum required by im.file.create. */
export function normalizeFeishuFileType(fileName: string): FeishuFileType {
  const extension = extname(fileName).toLowerCase()
  if (extension === '.opus') return 'opus'
  if (extension === '.mp4') return 'mp4'
  if (extension === '.pdf') return 'pdf'
  if (extension === '.doc' || extension === '.docx') return 'doc'
  if (extension === '.xls' || extension === '.xlsx') return 'xls'
  if (extension === '.ppt' || extension === '.pptx') return 'ppt'
  return 'stream'
}

async function readFeishuStream(
  response: { getReadableStream: () => AsyncIterable<Buffer | string> },
  maxBytes: number,
): Promise<Buffer> {
  const stream = response.getReadableStream()
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) throw new Error(`飞书资源超过 ${formatBytes(maxBytes)} 限制`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Keep an incoming Feishu filename inside the workspace and Windows-safe. */
export function sanitizeFileName(fileName: string): string {
  const leaf = basename(fileName.replaceAll('\\', '/'))
  const cleaned = leaf
    .replace(/[<>:"/|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
  const fallback = cleaned === '' ? 'feishu-file' : cleaned
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(fallback) ? `_${fallback}` : fallback
  return reserved.slice(0, 180)
}

/** Parse `/send <workspace-relative-path>` (and its Chinese alias). */
export function parseSendCommand(command: string): string | null {
  const match = command.trim().match(/^\/(?:send|发送)(?:\s+([\s\S]+))?$/i)
  if (match === null) return null
  const raw = match[1]?.trim() ?? ''
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return raw.slice(1, -1).trim()
  }
  return raw
}

/** Return true when a resolved path is inside (or equal to) a workspace root. */
export function isPathInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return relativePath === '' || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function saveIncomingFile(
  bridge: DshBridge,
  chatId: string,
  messageId: string,
  fileName: string,
  data: Buffer,
): Promise<{ path: string; relativePath: string; fileName: string; bytes: number }> {
  const workspace = await bridge.workspaceDir(chatId)
  if (!workspace.ok) throw new Error(workspace.error)
  const root = resolve(workspace.dir)
  const inbox = resolve(root, FEISHU_INBOX_DIR)
  await mkdir(inbox, { recursive: true })

  const safeName = sanitizeFileName(fileName)
  const extension = extname(safeName)
  const stem = basename(safeName, extension)
  let candidate = resolve(inbox, safeName)
  if (await pathExists(candidate)) candidate = resolve(inbox, `${stem}-feishu-${messageId.slice(-8)}${extension}`)
  if (await pathExists(candidate)) candidate = resolve(inbox, `${stem}-feishu-${randomUUID().slice(0, 8)}${extension}`)
  if (!isPathInside(root, candidate)) throw new Error('飞书文件路径校验失败')

  await writeFile(candidate, data, { flag: 'wx' })
  return {
    path: candidate,
    relativePath: relative(root, candidate).split(sep).join('/'),
    fileName: basename(candidate),
    bytes: data.length,
  }
}

async function resolveWorkspaceFile(workspaceDir: string, requestedPath: string): Promise<{
  path: string
  relativePath: string
  fileName: string
  bytes: number
}> {
  const root = await realpath(resolve(workspaceDir))
  const cleanPath = requestedPath.trim()
  if (cleanPath === '') throw new Error('请提供要发送的文件路径')
  const candidate = resolve(root, cleanPath)
  if (!isPathInside(root, candidate)) throw new Error('只能发送 DSH 工作目录内的文件')

  let actual: string
  try {
    actual = await realpath(candidate)
  } catch {
    throw new Error(`文件不存在: ${cleanPath}`)
  }
  if (!isPathInside(root, actual)) throw new Error('不能发送工作目录外的文件')
  const details = await stat(actual)
  if (!details.isFile()) throw new Error(`不是普通文件: ${cleanPath}`)
  return {
    path: actual,
    relativePath: relative(root, actual).split(sep).join('/'),
    fileName: basename(actual),
    bytes: details.size,
  }
}

/** Single-line, length-capped text for log lines. */
function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

// ── plugin entry ────────────────────────────────────────────────────────────

const HELP_TEXT = (trigger: string, p2pNoTrigger: boolean) => [
  p2pNoTrigger
    ? `私聊直接发消息即可；群聊发送 ${trigger === '' ? '任意消息' : `${trigger} <你的指令>`}。`
    : `发送 ${trigger === '' ? '任意消息' : `${trigger} <你的指令>`} 即可让本机 DSH 执行并回复。`,
  '',
  '命令:',
  '  /help    显示本帮助',
  '  /status  显示桥接状态',
  '  /new     为当前飞书会话开启一个新的 DSH 会话（清空上下文）',
  '  /send <路径>  将工作目录内的文件发送回当前飞书会话',
  '',
  '发送到飞书的文件会保存到 DSH 工作目录的 .feishu-inbox/；发送文件仅允许访问工作目录内的普通文件。',
  '当前飞书会话与一个 DSH 会话一一对应，历史上下文会被保留。',
].join('\n')

export function apply(ctx: HostContext, config: unknown): void {
  if (ctx.apiProxy?.sessions === undefined) {
    ctx.logger?.warn?.('feishu: host apiProxy.sessions is unavailable; bridge disabled')
    return
  }

  // Composition config (cordis.patch.yml) is the base layer; the Settings
  // page writes into the normal dsh settings document on top of it.
  let current = resolveConfig(config)
  let settingsScope: SettingsScopeLike | undefined
  if (ctx.settings !== undefined) {
    settingsScope = ctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config as FeishuConfig })
    current = resolveConfig(settingsScope.get())
  }

  const queue = new ChatQueue()
  let bridge = new DshBridge(ctx, current)
  let feishu: FeishuBridge | undefined
  /** Simulate route installs a sink that captures outbound replies instead of sending them to Feishu. */
  let replySink: ((chatId: string, text: string) => Promise<void>) | undefined

  const credentials = (cfg: FeishuConfig) => ({
    appId: (cfg.appId.trim() || (process.env.DSH_FEISHU_APP_ID ?? '')).trim(),
    appSecret: (cfg.appSecret.trim() || (process.env.DSH_FEISHU_APP_SECRET ?? '')).trim(),
  })

  const deliver = async (chatId: string, text: string): Promise<void> => {
    if (replySink !== undefined) {
      await replySink(chatId, text)
      return
    }
    const target = feishu
    if (target === undefined) return
    await target.sendText(chatId, text)
  }

  const deliverChunks = async (chatId: string, text: string): Promise<void> => {
    for (const chunk of splitReply(text, current.replyChunkSize)) {
      await deliver(chatId, chunk)
      await sleep(250)
    }
  }

  const submitParsed = (parsed: { text: string; chatId: string; chatType: string }): void => {
    queue.enqueue(parsed.chatId, () => handleIncoming(parsed.chatId, parsed.chatType, parsed))
  }

  const submitImageParsed = (parsed: NonNullable<ReturnType<typeof parseImageEvent>>): void => {
    // Group image messages only trigger when the bot was mentioned; private
    // images always trigger (matching p2p text behavior).
    if (parsed.chatType === 'group' && !isBotMentioned(parsed.mentions ?? [], current.trigger)) return
    debugLog(`submitImageParsed chat=${parsed.chatId} msg=${parsed.messageId} key=${parsed.imageKey}`)
    queue.enqueue(parsed.chatId, async () => {
      try {
        const target = feishu
        if (target === undefined) return
        debugLog(`downloadImage start msg=${parsed.messageId} key=${parsed.imageKey}`)
        const image = await target.downloadImage(parsed.messageId, parsed.imageKey)
        debugLog(`downloadImage done msg=${parsed.messageId} type=${image.mediaType} dataLen=${image.data.length}`)
        await handleImageIncoming(parsed.chatId, parsed.chatType, [{
          type: 'image',
          mediaType: image.mediaType,
          data: image.data,
          name: 'feishu-image',
        }])
        debugLog(`handleImageIncoming finished chat=${parsed.chatId}`)
      } catch (error) {
        debugLog(`image processing failed: ${describe(error)}`)
        ctx.logger?.error?.('feishu: image processing failed: %s', describe(error))
        try {
          await deliver(parsed.chatId, `图片处理失败: ${describe(error)}`)
        } catch {
          // keep the bridge alive
        }
      }
    })
  }

  const submitFileParsed = (parsed: NonNullable<ReturnType<typeof parseFileEvent>>): void => {
    // Group file messages only trigger when the bot was mentioned; private
    // file messages always trigger (matching p2p text and image behavior).
    if (parsed.chatType === 'group' && !isBotMentioned(parsed.mentions ?? [], current.trigger)) return
    debugLog(`submitFileParsed chat=${parsed.chatId} msg=${parsed.messageId} key=${parsed.fileKey} name=${excerpt(parsed.fileName)}`)
    queue.enqueue(parsed.chatId, async () => {
      try {
        const target = feishu
        if (target === undefined) return
        debugLog(`downloadFile start msg=${parsed.messageId} key=${parsed.fileKey}`)
        const file = await target.downloadFile(parsed.messageId, parsed.fileKey)
        debugLog(`downloadFile done msg=${parsed.messageId} type=${file.contentType} bytes=${file.data.length}`)
        const saved = await saveIncomingFile(bridge, parsed.chatId, parsed.messageId, parsed.fileName, file.data)
        await handleFileIncoming(parsed.chatId, parsed.chatType, saved)
        debugLog(`handleFileIncoming finished chat=${parsed.chatId} path=${saved.relativePath}`)
      } catch (error) {
        debugLog(`file processing failed: ${describe(error)}`)
        ctx.logger?.error?.('feishu: file processing failed: %s', describe(error))
        try {
          await deliver(parsed.chatId, `文件处理失败: ${describe(error)}`)
        } catch {
          // keep the bridge alive
        }
      }
    })
  }

  const submitPostParsed = (parsed: NonNullable<ReturnType<typeof parsePostEvent>>): void => {
    // Text-only rich text behaves like a normal text message.
    if (parsed.imageKeys.length === 0) {
      submitParsed({ text: parsed.text, chatId: parsed.chatId, chatType: parsed.chatType })
      return
    }
    if (parsed.chatType === 'group' && !isBotMentioned(parsed.mentions ?? [], current.trigger)) return
    debugLog(`submitPostParsed chat=${parsed.chatId} msg=${parsed.messageId} images=${parsed.imageKeys.length} text=${parsed.text.slice(0, 80)}`)
    queue.enqueue(parsed.chatId, async () => {
      try {
        const target = feishu
        if (target === undefined) return
        const content: PromptContentPart[] = []
        if (parsed.text !== '') content.push({ type: 'text', text: parsed.text })
        for (let index = 0; index < parsed.imageKeys.length; index += 1) {
          const imageKey = parsed.imageKeys[index]
          debugLog(`post downloadImage start ${index + 1}/${parsed.imageKeys.length} key=${imageKey}`)
          const image = await target.downloadImage(parsed.messageId, imageKey)
          debugLog(`post downloadImage done ${index + 1}/${parsed.imageKeys.length} type=${image.mediaType} dataLen=${image.data.length}`)
          content.push({
            type: 'image',
            mediaType: image.mediaType,
            data: image.data,
            name: `feishu-image-${index + 1}`,
          })
        }
        await handleImageIncoming(parsed.chatId, parsed.chatType, content)
        debugLog(`handleImageIncoming(post) finished chat=${parsed.chatId}`)
      } catch (error) {
        debugLog(`post processing failed: ${describe(error)}`)
        ctx.logger?.error?.('feishu: post processing failed: %s', describe(error))
        try {
          await deliver(parsed.chatId, `图文消息处理失败: ${describe(error)}`)
        } catch {
          // keep the bridge alive
        }
      }
    })
  }

  const startFeishu = (): void => {
    const creds = credentials(current)
    if (creds.appId === '' || creds.appSecret === '') {
      ctx.logger?.warn?.('feishu: appId/appSecret not configured; bridge disabled (fill them in Settings → 飞书)')
      return
    }
    feishu = new FeishuBridge(creds.appId, creds.appSecret, (event) => {
      if (event.message?.chat_id === undefined) return
      debugLog(`event received type=${event.message.message_type} chat=${event.message.chat_id} msg=${event.message.message_id}`)
      const textParsed = parseTextEvent(event)
      if (textParsed !== null) {
        submitParsed(textParsed)
        return
      }
      const imageParsed = parseImageEvent(event)
      if (imageParsed !== null) {
        submitImageParsed(imageParsed)
        return
      }
      const fileParsed = parseFileEvent(event)
      if (fileParsed !== null) {
        submitFileParsed(fileParsed)
        return
      }
      const postParsed = parsePostEvent(event)
      if (postParsed !== null) submitPostParsed(postParsed)
    }, ctx.logger)
    feishu.start()
    ctx.logger?.info?.(
      'feishu: bridge started (app %s, trigger %s)',
      maskAppId(creds.appId),
      current.trigger === '' ? '(all)' : current.trigger,
    )
  }

  const stopFeishu = (): void => {
    if (feishu !== undefined) {
      feishu.close()
      feishu = undefined
    }
  }

  const handleCommand = async (chatId: string, prompt: string): Promise<boolean> => {
    const command = prompt.trim()
    if (command === '/help' || command === '/帮助') {
      await deliverChunks(chatId, HELP_TEXT(current.trigger, current.p2pNoTrigger))
      return true
    }
    if (command === '/status' || command === '/状态') {
      const creds = credentials(current)
      const lines = [
        'DSH 飞书桥运行中',
        `飞书长连接: ${feishu?.isReady() === true ? '已连接' : '未就绪'}`,
        `AppId: ${maskAppId(creds.appId)}`,
        `触发词: ${current.trigger === '' ? '（全部消息）' : current.trigger}`,
        `私聊免 @: ${current.p2pNoTrigger ? '是' : '否'}`,
        `工作目录: ${current.cwd.trim() === '' ? '（宿主默认）' : current.cwd}`,
        `DSH 会话数: ${bridge.sessionCount()}`,
        `待处理队列: ${queue.size()}`,
      ]
      await deliverChunks(chatId, lines.join('\n'))
      return true
    }
    if (command === '/new' || command === '/reset' || command === '/新会话') {
      const newId = bridge.newChat(chatId)
      await deliverChunks(chatId, `已开启新的 DSH 会话（${newId}）。`)
      return true
    }
    const sendPath = parseSendCommand(command)
    if (sendPath !== null) {
      if (sendPath === '') {
        await deliver(chatId, '用法：/send <工作目录内的文件路径>')
        return true
      }
      const target = feishu
      if (target === undefined) {
        await deliver(chatId, '飞书长连接尚未就绪，暂时不能发送文件。')
        return true
      }
      try {
        const workspace = await bridge.workspaceDir(chatId)
        if (!workspace.ok) throw new Error(workspace.error)
        const file = await resolveWorkspaceFile(workspace.dir, sendPath)
        if (file.bytes > FEISHU_MAX_UPLOAD_BYTES) {
          throw new Error(`文件超过飞书机器人单文件 30 MB 限制（当前 ${formatBytes(file.bytes)}）`)
        }
        const data = await readFile(file.path)
        await target.sendFile(chatId, data, file.fileName)
      } catch (error) {
        ctx.logger?.error?.('feishu: file send failed: %s', describe(error))
        await deliver(chatId, `文件发送失败: ${describe(error)}`)
      }
      return true
    }
    return false
  }

  const isCorruptedSessionReply = (reply: string): boolean =>
    reply.includes('结束原因: error') &&
    (reply.includes('insufficient tool messages') || reply.includes('tool_calls') || reply.includes('tool messages'))

  const runWithRecovery = async (chatId: string, content: PromptContentPart[]): Promise<string> => {
    const first = await bridge.runContent(chatId, content)
    if (!isCorruptedSessionReply(first)) return first
    ctx.logger?.warn?.('feishu: DSH session tool-call history corrupted; resetting session and retrying once')
    debugLog(`session corrupted, resetting chat=${chatId} and retrying`)
    bridge.newChat(chatId)
    return bridge.runContent(chatId, content)
  }

  const handleIncoming = async (chatId: string, chatType: string, parsed: { text: string }): Promise<void> => {
    // Private chats skip the trigger when p2pNoTrigger is on; group chats
    // always require the configured trigger (default `@dsh`).
    const effectiveTrigger = chatType === 'p2p' && current.p2pNoTrigger ? '' : current.trigger
    const prompt = resolvePrompt(parsed.text, effectiveTrigger)
    if (prompt === null) return
    if (prompt.trim() === '') {
      await deliverChunks(chatId, HELP_TEXT(current.trigger, current.p2pNoTrigger))
      return
    }
    if (await handleCommand(chatId, prompt)) return
    if (current.ack) {
      try {
        await deliver(chatId, '收到，DSH 处理中…')
      } catch (error) {
        ctx.logger?.warn?.('feishu: ack send failed: %s', describe(error))
      }
    }
    try {
      const reply = await runWithRecovery(chatId, [{ type: 'text', text: prompt }])
      await deliverChunks(chatId, reply)
    } catch (error) {
      ctx.logger?.error?.('feishu: run failed: %s', describe(error))
      try {
        await deliver(chatId, `DSH 处理出错: ${describe(error)}`)
      } catch {
        // give up silently; the bridge stays up
      }
    }
  }

  const handleImageIncoming = async (chatId: string, chatType: string, content: PromptContentPart[]): Promise<void> => {
    debugLog(`handleImageIncoming start chat=${chatId} parts=${content.map((part) => part.type).join(',')}`)
    // Image messages have no text trigger; the group-mentioned check happened
    // before enqueue. Private images always run.
    if (current.ack) {
      try {
        await deliver(chatId, '收到，DSH 处理中…')
      } catch (error) {
        ctx.logger?.warn?.('feishu: ack send failed: %s', describe(error))
      }
    }
    try {
      const reply = await runWithRecovery(chatId, content)
      await deliverChunks(chatId, reply)
    } catch (error) {
      ctx.logger?.error?.('feishu: image run failed: %s', describe(error))
      try {
        await deliver(chatId, `DSH 处理出错: ${describe(error)}`)
      } catch {
        // give up silently; the bridge stays up
      }
    }
  }

  const handleFileIncoming = async (
    chatId: string,
    _chatType: string,
    file: { relativePath: string; fileName: string; bytes: number },
  ): Promise<void> => {
    debugLog(`handleFileIncoming start chat=${chatId} path=${file.relativePath} bytes=${file.bytes}`)
    if (current.ack) {
      try {
        await deliver(chatId, '收到文件，正在交给 DSH 处理…')
      } catch (error) {
        ctx.logger?.warn?.('feishu: file ack send failed: %s', describe(error))
      }
    }
    try {
      const prompt = [
        `用户从飞书发送了文件「${file.fileName}」。`,
        `文件已保存到当前 DSH 工作目录：${file.relativePath}（${formatBytes(file.bytes)}）。`,
        '请按用户上下文检查或处理这个文件。',
      ].join('\n')
      const reply = await runWithRecovery(chatId, [{ type: 'text', text: prompt }])
      await deliverChunks(chatId, reply)
    } catch (error) {
      ctx.logger?.error?.('feishu: file run failed: %s', describe(error))
      try {
        await deliver(chatId, `DSH 文件处理出错: ${describe(error)}`)
      } catch {
        // give up silently; the bridge stays up
      }
    }
  }

  startFeishu()

  // Settings page writes flow through the namespace watcher: credential
  // changes restart the Feishu long connection, everything else is picked
  // up on the next message.
  const unwatch = settingsScope?.watch((next) => {
    const nextConfig = resolveConfig(next)
    const before = credentials(current)
    current = nextConfig
    const after = credentials(nextConfig)
    bridge = new DshBridge(ctx, nextConfig)
    if (before.appId !== after.appId || before.appSecret !== after.appSecret) {
      stopFeishu()
      startFeishu()
    }
    ctx.logger?.info?.('feishu: settings updated (trigger %s)', nextConfig.trigger === '' ? '(all)' : nextConfig.trigger)
  })

  if (ctx.webServer !== undefined) {
    const disposeAll: Array<() => void> = []
    disposeAll.push(registerSettingsRoute(ctx, settingsScope, () => current, () => feishu?.isReady() ?? false, credentials))
    disposeAll.push(
      registerSimulateRoute(ctx, {
        queue,
        submit: submitParsed,
        setSink: (sink) => {
          replySink = sink
        },
      }),
    )
    // Route disposers must be effect-owned so hot reload / unload removes the
    // old routes before a fresh apply re-registers the same prefixes.
    ctx.effect?.(() => () => {
      for (const dispose of disposeAll) {
        try {
          dispose()
        } catch {
          // Best-effort teardown.
        }
      }
    }, 'feishu: settings + simulate routes')
  }

  ctx.effect?.(() => () => {
    unwatch?.()
    stopFeishu()
    ctx.logger?.info?.('feishu: bridge stopped')
  }, 'feishu: close long connection')
}

// ── settings route (Settings page ↔ host settings document) ────────────────

const CONFIG_FIELDS = ['appId', 'appSecret', 'trigger', 'p2pNoTrigger', 'cwd', 'agentPreset', 'ack', 'replyChunkSize', 'timeoutMs'] as const

interface SettingsRouteDeps {
  ctx: HostContext
  scope: SettingsScopeLike | undefined
  current: () => FeishuConfig
  ready: () => boolean
  credentials: (cfg: FeishuConfig) => { appId: string; appSecret: string }
}

function sendJson(res: RouteResponse, status: number, payload: object): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function readRequestBody(req: RouteRequest): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    req.on?.('data', (chunk) => {
      chunks.push(chunk)
    })
    req.on?.('end', () => {
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    req.on?.('error', (error) => {
      rejectPromise(error)
    })
  })
}

function registerSettingsRoute(
  ctx: HostContext,
  scope: SettingsScopeLike | undefined,
  current: () => FeishuConfig,
  ready: () => boolean,
  credentials: (cfg: FeishuConfig) => { appId: string; appSecret: string },
): () => void {
  const deps: SettingsRouteDeps = { ctx, scope, current, ready, credentials }
  return ctx.webServer?.register({
    kind: 'prefix',
    path: SETTINGS_ROUTE,
    handler: (req, res) => handleSettingsRequest(deps, req, res),
  }) ?? (() => {})
}

async function handleSettingsRequest(deps: SettingsRouteDeps, req: RouteRequest, res: RouteResponse): Promise<void> {
  if (req.method === 'GET') {
    sendSettingsSnapshot(deps, res)
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: '仅支持 GET/POST' })
    return
  }
  if (deps.scope === undefined) {
    sendJson(res, 200, { ok: false, message: 'settings service unavailable' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await readRequestBody(req)) as Record<string, unknown>
  } catch {
    sendJson(res, 200, { ok: false, message: '请求格式错误' })
    return
  }
  try {
    const source = typeof payload.patch === 'object' && payload.patch !== null ? payload.patch as Record<string, unknown> : {}
    const patch: Record<string, unknown> = {}
    for (const field of CONFIG_FIELDS) {
      if (field in source) patch[field] = source[field]
    }
    if (Object.keys(patch).length > 0) await deps.scope.update(patch)
    sendSettingsSnapshot(deps, res)
  } catch (error) {
    sendJson(res, 200, { ok: false, message: error instanceof Error ? error.message : String(error) })
  }
}

function sendSettingsSnapshot(deps: SettingsRouteDeps, res: RouteResponse): void {
  const config = deps.current()
  const creds = deps.credentials(config)
  sendJson(res, 200, {
    ok: true,
    writable: deps.scope !== undefined,
    ready: deps.ready(),
    config: { ...config, appId: creds.appId, appSecret: creds.appSecret },
    envFallback: {
      appId: config.appId.trim() === '' && process.env.DSH_FEISHU_APP_ID !== undefined,
      appSecret: config.appSecret.trim() === '' && process.env.DSH_FEISHU_APP_SECRET !== undefined,
    },
  })
}

// ── local end-to-end simulation route ───────────────────────────────────────

interface SimulateRouteDeps {
  queue: ChatQueue
  submit: (parsed: { text: string; chatId: string; chatType: string }) => void
  setSink: (sink: ((chatId: string, text: string) => Promise<void>) | undefined) => void
}

const SIMULATE_TIMEOUT_MS = 10 * 60 * 1000

function registerSimulateRoute(ctx: HostContext, deps: SimulateRouteDeps): () => void {
  let busy = false
  return ctx.webServer?.register({
    kind: 'prefix',
    path: SIMULATE_ROUTE,
    handler: (req, res) => handleSimulateRequest(deps, req, res, () => busy, (next) => {
      busy = next
    }),
  }) ?? (() => {})
}

async function handleSimulateRequest(
  deps: SimulateRouteDeps,
  req: RouteRequest,
  res: RouteResponse,
  busy: () => boolean,
  setBusy: (next: boolean) => void,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: '仅支持 POST' })
    return
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(await readRequestBody(req)) as Record<string, unknown>
  } catch {
    sendJson(res, 400, { ok: false, message: '请求格式错误' })
    return
  }
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : ''
  if (!chatId.startsWith('sim-')) {
    sendJson(res, 400, { ok: false, message: 'chatId 必须以 sim- 开头（模拟会话专用）' })
    return
  }
  if (busy()) {
    sendJson(res, 409, { ok: false, message: '已有模拟任务在进行中' })
    return
  }
  const text = typeof payload.text === 'string' ? payload.text : ''
  const chatType = payload.chatType === 'group' ? 'group' : 'p2p'
  if (text.trim() === '') {
    sendJson(res, 400, { ok: false, message: 'text 不能为空' })
    return
  }

  // Capture every outbound reply (ack + final answer) instead of sending it
  // to Feishu. The message otherwise follows the exact real pipeline.
  const replies: string[] = []
  setBusy(true)
  deps.setSink(async (_, reply) => {
    replies.push(reply)
  })
  try {
    deps.submit({ text, chatId, chatType })
    await Promise.race([
      deps.queue.whenIdle(chatId),
      new Promise<void>((resolve) => setTimeout(resolve, SIMULATE_TIMEOUT_MS)),
    ])
    sendJson(res, 200, { ok: true, replies })
  } catch (error) {
    sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
  } finally {
    deps.setSink(undefined)
    setBusy(false)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
