import { MemoryState } from './state.js'
import { PddTransport } from './pdd-transport.js'
import { DouyinTransport } from './douyin-transport.js'
import { timeout, delay, messageKey } from './util.js'

export class StoreClient {
  constructor(options) {
    if (!['pdd', 'douyin'].includes(options.platform) || !options.storeId) throw new Error('PLATFORM_AND_STORE_REQUIRED')
    this.options = options
    this.state = options.state || new MemoryState()
    this.transport = options.transport || (options.platform === 'pdd'
      ? new PddTransport(options) : new DouyinTransport(options))
    this.debounceMs = options.debounceMs ?? (options.platform === 'douyin' ? 3500 : 0)
    this.graceMs = options.graceMs ?? (options.platform === 'pdd' ? 1200 : 100)
    this.receiveQueue = Promise.resolve()
    this.sendQueue = Promise.resolve()
    this.paused = new Set()
    this.ownedOutgoing = new Set()
    this.inFlight = new Map()
    this.lastMerchantAt = new Map()
    this.generations = new Map()
    this.controllers = new Map()
    this.buckets = new Map()
    this.running = false
    this.autoReply = false
    this.ready = false
    this.epoch = 0
  }
  key(message) { return messageKey(this.options.platform, this.options.storeId, message.platformMessageId) }
  conversationKey(id) { return messageKey(this.options.platform, this.options.storeId, id) }
  emit(event) {
    try { Promise.resolve(this.options.onEvent?.(structuredClone(event))).catch(() => {}) }
    catch { /* Consumer UI/storage hooks do not break the receive loop. */ }
  }
  enqueueReceive(work) {
    const job = this.receiveQueue.then(work)
    this.receiveQueue = job.catch(error => {
      this.autoReply = false
      this.cancelPending()
      this.emit({ kind: 'error', code: 'RECEIVE_OR_STATE_ERROR', message: error.message })
    })
    return job
  }
  async start() {
    if (this.running) throw new Error('CLIENT_ALREADY_STARTED')
    const saved = await this.state.snapshot()
    for (const id of saved.paused) this.paused.add(id)
    for (const record of Object.values(saved.records)) {
      if (record.platform === this.options.platform && record.storeId === this.options.storeId &&
        record.receipt?.platformMessageId) this.ownedOutgoing.add(record.receipt.platformMessageId)
    }
    this.startedAt = Date.now()
    this.running = true
    this.autoReply = false // Explicit opt-in on every start; no hidden persisted-enable setting.
    try { await this.transport.start(event => this.handle(event)) }
    catch (error) { this.running = false; this.ready = false; throw error }
  }
  handle(event) {
    if (!this.running) return
    if (event.kind === 'status') {
      this.ready = event.ready === true
      if (!this.ready) { this.autoReply = false; this.cancelPending() }
      this.emit(event)
      return
    }
    if (event.kind === 'manual') {
      void this.pauseConversation(event.conversationId).catch(error => {
        this.autoReply = false
        this.cancelPending()
        this.emit({ kind: 'error', code: 'MANUAL_STATE_WRITE_FAILED', message: error.message })
      })
      return
    }
    const message = event.message
    if (!message?.platformMessageId || !message.buyerId || !message.conversationId ||
      !['in', 'out'].includes(message.direction) ||
      (message.profileId && message.profileId !== this.options.storeId)) return
    if (message.direction === 'out') { this.handleOutgoing(message, event.source); return }
    void this.enqueueReceive(async () => {
      const key = this.key(message)
      const claimed = await this.state.transact(draft => {
        if (draft.records[key]) return false
        draft.records[key] = {
          platform: this.options.platform, storeId: this.options.storeId,
          inboundMessageId: message.platformMessageId, buyerId: message.buyerId,
          conversationId: message.conversationId, receivedAt: message.receivedAt, status: 'observed'
        }
        return true
      })
      if (!claimed) { this.emit({ kind: 'duplicate', messageId: message.platformMessageId }); return }
      // Observation is independent of auto-reply. Cards/media still reach the consumer.
      this.emit({ kind: 'message', message, source: event.source })
      const cutoff = this.options.recoverSince ?? this.startedAt - 5000
      const eligible = message.contentType === 'text' && message.text?.trim() &&
        !['用户正在查看商品', '用户进入了商品详情页'].includes(message.text) &&
        (event.source !== 'history' || (event.hasTimestamp && message.occurredAt >= cutoff &&
          message.occurredAt > (this.lastMerchantAt.get(message.conversationId) || 0)))
      if (!this.running || !this.autoReply || !this.ready || !eligible ||
        this.paused.has(this.conversationKey(message.conversationId))) return
      this.schedule({ ...message, source: event.source })
    }).catch(() => {})
  }
  handleOutgoing(message, source = 'live') {
    if (this.ownedOutgoing.has(message.platformMessageId)) {
      this.emit({ kind: 'merchant-echo', message })
      return
    }
    const pending = this.inFlight.get(message.buyerId)
    if (pending && (message.text || '').replace(/\s+/g, ' ').trim() === pending.text.replace(/\s+/g, ' ').trim()) {
      // Echo may arrive before the HTTP/SDK promise returns. Reconcile after saving receipt.
      pending.echoes.push({ message, source })
      return
    }
    if (source === 'history') {
      // Old merchant history is not a new manual send event. Only suppress older unanswered history.
      this.lastMerchantAt.set(message.conversationId,
        Math.max(message.occurredAt || 0, this.lastMerchantAt.get(message.conversationId) || 0))
      return
    }
    void this.pauseConversation(message.conversationId).catch(error => this.emit({ kind: 'error', message: error.message }))
  }
  schedule(message) {
    if (!this.debounceMs) { this.queueBatch([message]); return }
    const id = message.conversationId
    const bucket = this.buckets.get(id) || { messages: [] }
    bucket.messages.push(message)
    clearTimeout(bucket.timer)
    bucket.timer = setTimeout(() => {
      this.buckets.delete(id)
      this.queueBatch(bucket.messages)
    }, this.debounceMs)
    this.buckets.set(id, bucket)
  }
  async mark(messages, status, extra = {}) {
    await this.state.transact(draft => {
      for (const message of messages) {
        const record = draft.records[this.key(message)]
        if (record) Object.assign(record, { status, updatedAt: Date.now() }, extra)
      }
    })
  }
  queueBatch(messages) {
    const last = messages.at(-1)
    const epoch = this.epoch
    const generation = this.generations.get(last.conversationId) || 0
    const valid = () => this.running && this.autoReply && this.ready && this.epoch === epoch &&
      (this.generations.get(last.conversationId) || 0) === generation &&
      !this.paused.has(this.conversationKey(last.conversationId)) &&
      (last.source !== 'history' || last.occurredAt > (this.lastMerchantAt.get(last.conversationId) || 0))
    const job = this.sendQueue.then(async () => {
      if (!valid()) { await this.mark(messages, 'cancelled'); return }
      if (!this.options.decide) { await this.mark(messages, 'no-reply'); return }
      const controller = new AbortController()
      this.controllers.set(last.conversationId, controller)
      try {
        await this.mark(messages, 'deciding')
        const context = structuredClone({ messages, last })
        const text = await timeout(this.options.decide({ ...context, signal: controller.signal }),
          this.options.decisionTimeoutMs ?? 30000, 'DECISION_TIMEOUT')
        if (!valid()) { await this.mark(messages, 'cancelled'); return }
        if (text == null || text === '') { await this.mark(messages, 'no-reply'); return }
        if (typeof text !== 'string' || !text.trim()) throw new Error('DECISION_EXPECTS_TEXT_OR_NULL')
        await delay(this.graceMs)
        if (!valid()) { await this.mark(messages, 'cancelled'); return }
        await this.mark(messages, 'sending')
        if (!valid()) { await this.mark(messages, 'cancelled'); return }
        const flight = { text, echoes: [] }
        this.inFlight.set(last.buyerId, flight)
        let receipt
        try {
          receipt = await this.transport.send({ buyerId: last.buyerId, text,
            inboundMessageId: last.platformMessageId, receivedAt: last.receivedAt })
        } catch (error) { receipt = { accepted: false, outcome: 'unknown', message: error.message } }
        try {
          if (receipt.accepted && receipt.platformMessageId) this.ownedOutgoing.add(receipt.platformMessageId)
          // Save only bounded receipt metadata, not full platform body or signature.
          const saved = {
            accepted: receipt.accepted === true && Boolean(receipt.platformMessageId),
            outcome: receipt.accepted && receipt.platformMessageId ? 'accepted' : 'unknown',
            platformMessageId: receipt.platformMessageId, method: receipt.method,
            code: receipt.code, message: receipt.message, at: Date.now()
          }
          await this.mark(messages, saved.outcome, { receipt: saved })
          this.emit({ kind: 'receipt', messageIds: messages.map(item => item.platformMessageId), receipt: saved })
        } finally {
          this.inFlight.delete(last.buyerId)
          for (const echo of flight.echoes) this.handleOutgoing(echo.message, echo.source)
        }
      } catch (error) {
        controller.abort()
        await this.mark(messages, 'failed', { error: error.message })
        this.emit({ kind: 'error', code: 'DECISION_OR_STATE_ERROR', message: error.message })
      } finally { this.controllers.delete(last.conversationId) }
    })
    this.sendQueue = job.catch(error => {
      this.autoReply = false
      this.cancelPending()
      this.emit({ kind: 'error', code: 'STATE_WRITE_FAILED', message: error.message })
    })
  }
  cancelPending() {
    this.epoch++
    for (const controller of this.controllers.values()) controller.abort()
    for (const bucket of this.buckets.values()) clearTimeout(bucket.timer)
    this.buckets.clear()
  }
  async setAutoReply(enabled) {
    if (enabled && (!this.running || !this.ready)) throw new Error('WAIT_FOR_TRANSPORT_READY')
    this.autoReply = enabled === true
    if (!this.autoReply) this.cancelPending()
    this.emit({ kind: 'auto-reply', enabled: this.autoReply })
  }
  async pauseConversation(id) {
    const key = this.conversationKey(id)
    this.paused.add(key)
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    this.controllers.get(id)?.abort()
    const bucket = this.buckets.get(id)
    if (bucket) clearTimeout(bucket.timer)
    this.buckets.delete(id)
    this.emit({ kind: 'paused', conversationId: id })
    await this.state.transact(draft => { if (!draft.paused.includes(key)) draft.paused.push(key) })
  }
  async resumeConversation(id) {
    const key = this.conversationKey(id)
    await this.state.transact(draft => { draft.paused = draft.paused.filter(item => item !== key) })
    this.generations.set(id, (this.generations.get(id) || 0) + 1)
    this.paused.delete(key)
  }
  async flush() {
    await this.receiveQueue
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.timer)
      this.queueBatch(bucket.messages)
    }
    this.buckets.clear()
    await this.sendQueue
  }
  async stop() {
    this.running = false
    this.autoReply = false
    this.ready = false
    this.cancelPending()
    await this.transport.stop()
    await this.receiveQueue
    await this.sendQueue
  }
  getStatus() { return { running: this.running, ready: this.ready, autoReply: this.autoReply } }
}
export const createStoreClient = options => new StoreClient(options)
