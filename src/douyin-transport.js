import { createDouyinPollScript, douyinSendScript, DOUYIN_DISPOSE_SCRIPT } from './douyin-page.js'
import { normalizeDouyinMessage } from './douyin-codec.js'
import { allowedFrame, timeout, validateSend } from './util.js'

export class DouyinTransport {
  constructor({ host, storeId, pollMs = 1500, timeoutMs = 12000, pullHistory = false }) {
    if (!host?.listFrames || !storeId) throw new Error('DOUYIN_HOST_AND_STORE_REQUIRED')
    Object.assign(this, { host, storeId, pollMs, timeoutMs, pullHistory })
    this.running = false
    this.polling = false
    this.ready = false
    this.installedFrames = new Set()
  }
  emit(event) { if (this.running) this.listener?.(event) }
  async start(listener) {
    if (this.running) throw new Error('TRANSPORT_ALREADY_STARTED')
    this.running = true
    this.listener = listener
    await this.poll()
    this.timer = setInterval(() => void this.poll(), this.pollMs)
  }
  async poll() {
    if (!this.running || this.polling) return
    this.polling = true
    try {
      let found = false
      const frames = await this.host.listFrames()
      for (const frame of frames.filter(frame => allowedFrame('douyin', frame.url))) {
        let result
        try { result = await timeout(this.host.evaluateMainWorld(frame.id, createDouyinPollScript({ pullHistory: this.pullHistory })), this.timeoutMs) }
        catch { continue }
        if (!this.running) {
          try { await this.host.evaluateMainWorld(frame.id, DOUYIN_DISPOSE_SCRIPT) } catch { /* Navigated. */ }
          return
        }
        if (!result?.ready) continue
        this.installedFrames.add(frame.id)
        this.frameId = frame.id
        found = true
        this.ready = true
        const events = [...(result.events || [])].sort((left, right) => {
          const time = event => {
            if (event.kind === 'manual') return event.at || Date.now()
            const value = Number(event.message?.createTime || event.message?.timestamp)
            return value > 1e12 ? value : value > 1e9 ? value * 1000 : Date.now()
          }
          return time(left) - time(right)
        })
        for (const event of events) {
          if (event.kind === 'manual') {
            this.emit({ ...event, conversationId: `dy:${event.conversationId}` })
            continue
          }
          const message = normalizeDouyinMessage(event, this.storeId)
          if (message) this.emit({ kind: 'message', message, source: event.source,
            hasTimestamp: Boolean(event.message?.createTime || event.message?.timestamp) })
        }
        break
      }
      this.ready = found
      this.emit({ kind: 'status', ready: this.ready, reason: this.ready ? undefined : 'PAGE_IM_NOT_READY' })
    } catch (error) {
      this.ready = false
      this.emit({ kind: 'status', ready: false, reason: error.message })
    } finally { this.polling = false }
  }
  async send(input) {
    validateSend(input)
    if (!this.running || !this.ready || !this.frameId) throw new Error('TRANSPORT_NOT_READY')
    const result = await timeout(this.host.evaluateMainWorld(this.frameId,
      douyinSendScript(input.buyerId, input.text, input.receivedAt || Date.now())),
      this.timeoutMs, 'SEND_RESULT_UNKNOWN')
    const accepted = result?.ok === true && Boolean(result.platformMessageId)
    return { ...result, accepted, outcome: accepted ? 'accepted' : 'unknown', method: 'page.im.sendText' }
  }
  async stop() {
    this.running = false
    this.ready = false
    clearInterval(this.timer)
    for (const id of this.installedFrames) {
      try { await timeout(this.host.evaluateMainWorld(id, DOUYIN_DISPOSE_SCRIPT), this.timeoutMs) }
      catch { /* Frame destroyed or navigated: old bridge is no longer used. */ }
    }
    this.installedFrames.clear()
  }
}
