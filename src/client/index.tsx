// Client plugin: a Settings page section for dsh-feishu. The card reads and
// writes the plugin's own HTTP route (`/plugin/dsh-feishu/settings`) because
// generic settings namespaces are not exposed through the remote settings API
// by default; the host validates every field with the same schemastery Config
// and persists it to the normal settings document.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import css from './index.css'

const NS = 'feishu'
const SETTINGS_ROUTE = '/plugin/dsh-feishu/settings'
const CSS_TAG = 'dsh-feishu/index.css'

// Inject the stylesheet once, at module materialization — the same
// data-plugin-css pattern the harness's own client bundles use.
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-feishu'
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = css
  document.head.appendChild(tag)
}

// ── config shape (mirrors the host Config) ─────────────────────────────────

interface FeishuConfig {
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

const DEFAULTS: FeishuConfig = {
  appId: '',
  appSecret: '',
  trigger: '@dsh',
  p2pNoTrigger: true,
  cwd: '',
  agentPreset: '',
  ack: true,
  replyChunkSize: 1800,
  timeoutMs: 600000,
}

function normalize(raw: unknown): FeishuConfig {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback
  return {
    appId: typeof source.appId === 'string' ? source.appId : DEFAULTS.appId,
    appSecret: typeof source.appSecret === 'string' ? source.appSecret : DEFAULTS.appSecret,
    trigger: typeof source.trigger === 'string' ? source.trigger : DEFAULTS.trigger,
    p2pNoTrigger: typeof source.p2pNoTrigger === 'boolean' ? source.p2pNoTrigger : DEFAULTS.p2pNoTrigger,
    cwd: typeof source.cwd === 'string' ? source.cwd : DEFAULTS.cwd,
    agentPreset: typeof source.agentPreset === 'string' ? source.agentPreset : DEFAULTS.agentPreset,
    ack: typeof source.ack === 'boolean' ? source.ack : DEFAULTS.ack,
    replyChunkSize: num(source.replyChunkSize, DEFAULTS.replyChunkSize, 100, 4000),
    timeoutMs: num(source.timeoutMs, DEFAULTS.timeoutMs, 5000, 3600000),
  }
}

// ── remote config store (host settings route) ──────────────────────────────

interface RemoteSnapshot {
  status: 'loading' | 'ready' | 'unavailable'
  config: FeishuConfig
  writable: boolean
  ready: boolean
}

interface RemoteConfigResponse {
  ok?: boolean
  config?: unknown
  writable?: boolean
  ready?: boolean
  message?: string
}

function createRemoteConfigStore() {
  let snapshot: RemoteSnapshot = {
    status: 'loading',
    config: { ...DEFAULTS },
    writable: false,
    ready: false,
  }
  const listeners = new Set<() => void>()

  const publish = (next: RemoteSnapshot): void => {
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const post = async (payload: Record<string, unknown> | null): Promise<RemoteConfigResponse> => {
    const response = await fetch(SETTINGS_ROUTE, {
      method: payload === null ? 'GET' : 'POST',
      headers: payload === null ? undefined : { 'Content-Type': 'application/json' },
      body: payload === null ? undefined : JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as RemoteConfigResponse
  }

  const accept = (data: RemoteConfigResponse): void => {
    if (data.ok !== true || typeof data.config !== 'object' || data.config === null) {
      publish({ ...snapshot, status: 'unavailable', writable: false })
      return
    }
    publish({
      status: 'ready',
      config: normalize(data.config),
      writable: data.writable !== false,
      ready: data.ready === true,
    })
  }

  return {
    getSnapshot: (): RemoteSnapshot => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load: async (): Promise<void> => {
      try {
        accept(await post(null))
      } catch {
        publish({ ...snapshot, status: 'unavailable', writable: false })
      }
    },
    save: async (patch: Record<string, unknown>): Promise<void> => {
      const data = await post({ patch })
      if (data.ok !== true) throw new Error(data.message ?? '保存失败')
      accept(data)
    },
  }
}

function useStoreSnapshot(store: ReturnType<typeof createRemoteConfigStore>) {
  return useSyncExternalStore(
    useMemo(() => (listener: () => void) => store.subscribe(listener), [store]),
    useMemo(() => () => store.getSnapshot(), [store]),
  )
}

// ── settings section slots ─────────────────────────────────────────────────

interface LocaleLike {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string) => string
}

interface SlotsLike {
  inject(name: string, register: () => void): void
  register(options: Record<string, unknown>, component: unknown): void
}

interface ClientContextLike {
  slots: SlotsLike
  locale: LocaleLike
  effect(callback: () => () => void, label: string): void
}

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContextLike): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-feishu: dictionaries')
  const t = ctx.locale.bind(NS)
  const store = createRemoteConfigStore()
  void store.load()

  ctx.slots.inject(
    'settings.section',
    () =>
      ctx.slots.register(
        {
          name: 'settings.section',
          id: 'feishu',
          order: 25,
          label: () => t('nav'),
          locale: NS,
          children: { 'settings.feishu.item': { kind: 'list', scope: 'root' } },
        },
        Section,
      ),
  )

  ctx.slots.inject(
    'settings.feishu.item',
    () =>
      ctx.slots.register(
        {
          name: 'settings.feishu.item',
          id: 'feishu-card',
          order: 0,
          locale: NS,
          inject: () => ({ store }),
        },
        FeishuCard,
      ),
  )
}

function Section({ renderSlot }: { renderSlot: (name: string, props: Record<string, never>) => ReactNode }) {
  return <div className="fz-section">{renderSlot('settings.feishu.item', {})}</div>
}

// ── settings card ───────────────────────────────────────────────────────────

function FeishuCard({ t, store }: { t: (key: string) => string; store: ReturnType<typeof createRemoteConfigStore> }) {
  const snapshot = useStoreSnapshot(store)
  const [draft, setDraft] = useState<FeishuConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  useEffect(() => {
    if (snapshot.status !== 'loading') setDraft(normalize(snapshot.config))
  }, [snapshot.status, snapshot.config])

  const editable = snapshot.writable && snapshot.status !== 'unavailable'
  const config = draft ?? normalize(snapshot.config)
  const configured = config.appId.trim() !== '' && config.appSecret.trim() !== ''
  const statusText = !configured
    ? t('status.unconfigured')
    : snapshot.ready
      ? t('status.ready')
      : t('status.connecting')

  const patch = (field: keyof FeishuConfig, value: unknown): void => {
    setDraft((prev) => ({ ...(prev ?? config), [field]: value }))
  }

  const save = async (): Promise<void> => {
    if (!editable) return
    setError(null)
    setSaving(true)
    try {
      await store.save({
        ...config,
        timeoutMs: config.timeoutMs,
      })
      setSavedAt(Date.now())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (snapshot.status === 'unavailable') {
    return (
      <div className="fz-card">
        <div className="fz-title">{t('title')}</div>
        <div className="fz-hint">{t('unavailable')}</div>
      </div>
    )
  }

  return (
    <div className="fz-card">
      <div className="fz-title">{t('title')}</div>
      <div className="fz-row fz-row-last">
        <span className="fz-label">{t('status')}</span>
        <span className={`fz-badge ${snapshot.ready ? 'fz-badge-on' : ''}`}>{statusText}</span>
      </div>

      <div className="fz-field">
        <label className="fz-label" htmlFor="fz-app-id">{t('appId')}</label>
        <input
          id="fz-app-id"
          className="fz-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="cli_xxxxxxxxxxxxxxxx"
          value={config.appId}
          disabled={!editable}
          onChange={(event) => patch('appId', event.target.value)}
        />
      </div>

      <div className="fz-field">
        <label className="fz-label" htmlFor="fz-app-secret">{t('appSecret')}</label>
        <input
          id="fz-app-secret"
          className="fz-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={config.appSecret}
          disabled={!editable}
          onChange={(event) => patch('appSecret', event.target.value)}
        />
      </div>

      <div className="fz-field">
        <label className="fz-label" htmlFor="fz-trigger">{t('trigger')}</label>
        <input
          id="fz-trigger"
          className="fz-input"
          type="text"
          value={config.trigger}
          disabled={!editable}
          onChange={(event) => patch('trigger', event.target.value)}
        />
        <div className="fz-sub">{t('trigger.hint')}</div>
      </div>

      <div className="fz-row">
        <span className="fz-label">{t('p2pNoTrigger')}</span>
        <label className="fz-switch">
          <input
            type="checkbox"
            checked={config.p2pNoTrigger}
            disabled={!editable}
            onChange={(event) => patch('p2pNoTrigger', event.target.checked)}
            aria-label={t('p2pNoTrigger')}
          />
          <span className="fz-track" aria-hidden="true" />
        </label>
      </div>
      <div className="fz-row fz-row-last">
        <span className="fz-hint">{t('p2pNoTrigger.hint')}</span>
      </div>

      <div className="fz-field">
        <label className="fz-label" htmlFor="fz-cwd">{t('cwd')}</label>
        <input
          id="fz-cwd"
          className="fz-input"
          type="text"
          value={config.cwd}
          disabled={!editable}
          onChange={(event) => patch('cwd', event.target.value)}
        />
        <div className="fz-sub">{t('cwd.hint')}</div>
      </div>

      <div className="fz-row">
        <span className="fz-label">{t('ack')}</span>
        <label className="fz-switch">
          <input
            type="checkbox"
            checked={config.ack}
            disabled={!editable}
            onChange={(event) => patch('ack', event.target.checked)}
            aria-label={t('ack')}
          />
          <span className="fz-track" aria-hidden="true" />
        </label>
      </div>

      <div className="fz-field">
        <label className="fz-label" htmlFor="fz-timeout">{t('timeout')}</label>
        <input
          id="fz-timeout"
          className="fz-input"
          type="number"
          min={1}
          max={60}
          step={1}
          value={Math.max(1, Math.round(config.timeoutMs / 60000))}
          disabled={!editable}
          onChange={(event) => patch('timeoutMs', Math.min(60, Math.max(1, Number(event.target.value) || 1)) * 60000)}
        />
        <div className="fz-sub">{t('timeout.hint')}</div>
      </div>

      <div className="fz-row fz-row-actions">
        <button type="button" className="fz-save" disabled={!editable || saving} onClick={() => void save()}>
          {saving ? t('saving') : t('save')}
        </button>
        {savedAt !== null && error === null && <span className="fz-sub">{t('saved')}</span>}
        {error !== null && <span className="fz-error">{error}</span>}
      </div>

      <div className="fz-row fz-row-last">
        <span className="fz-hint">{t('hint')}</span>
      </div>
    </div>
  )
}

// ── localized copy ──────────────────────────────────────────────────────────

const zh = {
  nav: '飞书',
  title: '飞书桥接（DSH）',
  status: '桥接状态',
  'status.ready': '已连接',
  'status.connecting': '连接中…',
  'status.unconfigured': '未配置 App ID / Secret',
  appId: 'App ID',
  appSecret: 'App Secret',
  trigger: '触发词',
  'trigger.hint': '群聊中消息以该前缀开头才交给 DSH；留空表示每条文本消息都触发。',
  p2pNoTrigger: '私聊免 @ 触发',
  'p2pNoTrigger.hint': '开启后与机器人私聊直接发消息即触发；群聊始终需要 @ 或触发词。关闭后私聊也要 @ 触发词开头。',
  cwd: '工作目录',
  'cwd.hint': '飞书消息创建的 DSH 会话工作目录；留空使用宿主默认。',
  ack: '先回复“处理中”',
  timeout: '等待上限（分钟）',
  'timeout.hint': 'DSH 超过该时长仍未结束就回复“仍在处理中”。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存，凭据变化会立即重连飞书。',
  unavailable: '设置服务不可用：请在 cordis.patch.yml 中配置，或检查宿主 settings 服务。',
  hint: 'App ID / App Secret 保存在本机 DSH 设置文档中；保存后无需重启 dsh web，长连接会自动重连。',
}

const en = {
  nav: 'Feishu',
  title: 'Feishu bridge (DSH)',
  status: 'Bridge status',
  'status.ready': 'Connected',
  'status.connecting': 'Connecting…',
  'status.unconfigured': 'App ID / Secret missing',
  appId: 'App ID',
  appSecret: 'App Secret',
  trigger: 'Trigger',
  'trigger.hint': 'In groups, messages starting with this prefix go to DSH; leave empty to trigger on every text message.',
  p2pNoTrigger: 'No @ needed in private chat',
  'p2pNoTrigger.hint': 'When on, private chats with the bot trigger on any text; groups always need the trigger. When off, private chats need the trigger too.',
  cwd: 'Working directory',
  'cwd.hint': 'Working directory for the DSH sessions created by Feishu messages; empty = host default.',
  ack: 'Reply “processing” first',
  timeout: 'Wait limit (minutes)',
  'timeout.hint': 'If DSH is still running past this limit, reply “still running”.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved; credential changes reconnect Feishu immediately.',
  unavailable: 'Settings service unavailable: configure via cordis.patch.yml or check the host settings service.',
  hint: 'App ID / App Secret are stored in the local DSH settings document; saving reconnects the long connection without restarting dsh web.',
}
