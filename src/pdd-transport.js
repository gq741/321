import { decodeTitanPayload, extractPddCandidates, normalizePddCandidate } from './pdd-codec.js'
import { createPddGuestSendScript, parsePddGuestSendResult } from './pdd-page.js'
import { allowedFrame, timeout, validateSend } from './util.js'

const PROBE = `(() => {
  if (location.hostname !== 'mms.pinduoduo.com') return {ready:false};
  const state=document.querySelector('#app')?.__vue__?.$store?.state || {};
  const signer=window.riskControlCrawler || state.riskControlCrawler || state.IMSDK?.riskControlCrawler;
  return {ready:Boolean((window.global_mall_id || state.userInfo?.mall_id) && typeof signer?.messagePack==='function')};
})()`

export class PddTransport {
  constructor({ host, storeId, pollMs = 1500, timeoutMs = 12000 }) {
    if (!host?.subscribeCdp || !storeId) throw new Error('PDD_HOST_AND_STORE_REQUIRED')
    Object.assign(this, { host, storeId, pollMs, timeoutMs })
    this.running = false
    this.captureActive = false
    this.polling = false
    this.ready = false
  }
  emit(event) { if (this.running) this.listener?.(event) }
  async start(listener) {
    if (this.running) throw new Error('TRANSPORT_ALREADY_STARTED')
    this.running = true
    this.listener = listener
    try {
      this.disposeCdp = await this.host.subscribeCdp(event => this.onCdp(event))
      this.captureActive = true
      await this.poll()
      this.timer = setInterval(() => void this.poll(), this.pollMs)
    } catch (error) { await this.stop(); throw error }
  }
  onCdp({ method, params = {} }) {
    if (!this.running) return
    if (method === 'Host.detached') {
      this.captureActive = false
      this.ready = false
      this.emit({ kind: 'status', ready: false, reason: 'CDP_DETACHED' })
      return
    }
    if (method === 'Network.webSocketFrameReceived') {
      const frame = params.response
      if (!frame || typeof frame.payloadData !== 'string') return
      for (const payload of decodeTitanPayload(frame.payloadData, frame.opcode)) {
        for (const candidate of extractPddCandidates(payload)) {
          const message = normalizePddCandidate(candidate, this.storeId)
          if (message) this.emit({ kind: 'message', message, source: 'live', hasTimestamp: true })
        }
      }
    }
    if (method === 'Network.requestWillBeSent') {
      const request = params.request || {}
      try {
        const url = new URL(request.url)
        if (url.origin !== 'https://mms.pinduoduo.com' || url.pathname !== '/plateau/chat/send_message') return
        const body = JSON.parse(request.postData || '{}')
        const message = body.data?.message
        if (Number(message?.manual_reply) === 1 && Number(message?.is_aut) !== 1 && message?.to?.uid) {
          const buyerId = String(message.to.uid)
          this.emit({ kind: 'manual', buyerId, conversationId: `pdd:${buyerId}`, at: Date.now() })
        }
      } catch { /* Ignore non-JSON/non-chat requests. */ }
    }
  }
  async poll() {
    if (!this.running || this.polling) return
    this.polling = true
    try {
      const frame = (await this.host.listFrames()).find(frame => allowedFrame('pdd', frame.url))
      const probe = frame ? await timeout(this.host.evaluateMainWorld(frame.id, PROBE), this.timeoutMs) : null
      if (!this.running) return
      this.frameId = frame?.id
      this.ready = probe?.ready === true && this.captureActive
      this.emit({ kind: 'status', ready: this.ready, reason: this.ready ? undefined : 'PAGE_OR_SIGNER_NOT_READY' })
    } catch (error) {
      this.ready = false
      this.emit({ kind: 'status', ready: false, reason: error.message })
    } finally { this.polling = false }
  }
  async send(input) {
    validateSend(input)
    if (!this.running || !this.ready || !this.frameId) throw new Error('TRANSPORT_NOT_READY')
    // The signer and fetch execute in the same logged-in frame; no main-process HTTP request.
    const raw = await timeout(this.host.evaluateMainWorld(this.frameId, createPddGuestSendScript({
      buyerId: input.buyerId, text: input.text, previousMessageId: input.inboundMessageId
    })), this.timeoutMs, 'SEND_RESULT_UNKNOWN')
    const result = parsePddGuestSendResult(raw)
    return { ...result, accepted: result.ok, outcome: result.ok ? 'accepted' : 'unknown' }
  }
  async stop() {
    this.running = false
    this.ready = false
    this.captureActive = false
    clearInterval(this.timer)
    await this.disposeCdp?.()
    this.disposeCdp = undefined
  }
}
