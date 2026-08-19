// Standalone Feishu long-connection probe: listens for im.message.receive_v1
// with the same credentials the plugin uses and appends every received event
// to feishu-probe.log. Used to tell whether events reach this machine at all.
import fs from 'node:fs'
import * as lark from '@larksuiteoapi/node-sdk'

const appId = process.env.DSH_PROBE_APP_ID ?? ''
const appSecret = process.env.DSH_PROBE_APP_SECRET ?? ''
const out = process.env.DSH_PROBE_OUT ?? 'C:/Users/Administrator/.dsh/feishu-probe.log'
const minutes = Number(process.env.DSH_PROBE_MINUTES ?? 20)

const log = (line) => {
  const text = `[${new Date().toISOString()}] ${line}\n`
  fs.appendFileSync(out, text)
  process.stdout.write(text)
}

if (!/^cli_[0-9a-fA-F]{16}$/.test(appId)) {
  log(`invalid appId ${appId}`)
  process.exit(2)
}

log(`probe starting (app ${appId.slice(0, 8)}…, ${minutes} min)`)
const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.info })
dispatcher.register({
  'im.message.receive_v1': (data) => {
    const message = data?.message
    log(`EVENT message_id=${message?.message_id} chat_id=${message?.chat_id} type=${message?.message_type} content=${JSON.stringify(message?.content)}`)
    return Promise.resolve()
  },
})
const ws = new lark.WSClient({
  appId,
  appSecret,
  domain: lark.Domain.Feishu,
  loggerLevel: lark.LoggerLevel.info,
  autoReconnect: true,
  onReady: () => log('WS READY'),
  onError: (error) => log(`WS ERROR ${error instanceof Error ? error.message : String(error)}`),
  onReconnecting: () => log('WS reconnecting'),
  onReconnected: () => log('WS reconnected'),
})
ws.start({ eventDispatcher: dispatcher })
setTimeout(() => {
  log('probe exiting')
  ws.close()
  process.exit(0)
}, minutes * 60 * 1000)
