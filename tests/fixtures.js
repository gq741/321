import vm from 'node:vm'
import { webcrypto } from 'node:crypto'

export function pddPage({ signature = () => 'SIGNATURE', response, hostname = 'mms.pinduoduo.com' } = {}) {
  const calls = []
  const state = { userInfo: { mall_id: 'MALL' }, riskControlCrawler: { messagePack: signature } }
  const context = vm.createContext({
    window: {}, location: { hostname },
    document: { querySelector: () => ({ __vue__: { $store: { state } } }) },
    crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout,
    fetch: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => response ||
        { success: true, result: { result: 'ok', msg_id: 'OUT-1' } } }
    }
  })
  return { calls, state, evaluate: script => vm.runInContext(script, context) }
}
export function dyPage({ hostname = 'im.jinritemai.com', noUnsubscribe = false } = {}) {
  const callbacks = []
  const calls = []
  const groups = {}
  const store = { conversationsInfo: { conversationMap: {}, messagesByConversationId: groups } }
  const im = {
    onMessage(callback) {
      callbacks.push(callback)
      if (!noUnsubscribe) return () => callbacks.splice(callbacks.indexOf(callback), 1)
    },
    async chatWithUid(uid) {
      store.conversationsInfo.currentConversation = { id: `CONV-${uid}`, buyerId: uid }
    },
    async sendText(id, text) {
      calls.push({ id, text })
      return { serverId: `OUT-${calls.length}`, flightStatus: 3, serverStatus: 0,
        ext: { 's:send_response_status': '0', 's:send_response_check_code': '0' } }
    }
  }
  const window = { __monaGlobalStore: { data: { initContextData: { im, Store: { instance: store } } } } }
  const context = vm.createContext({ window, location: { hostname }, document: { body: { innerText: '' } },
    Map, Set, setTimeout, clearTimeout })
  const evaluate = script => vm.runInContext(script, context)
  return { window, im, store, groups, callbacks, calls, evaluate }
}
export const dyMessage = (id, buyer = 'A', role = '1') => ({
  serverId: id, securityConversationId: `CONV-${buyer}`, securitySender: buyer,
  content: `text-${id}`, createTime: Date.now(), ext: { sender_role: role, type: 'text', buyer_id: buyer }
})
export function fakeHost(page, url, cdp = false) {
  let listener
  const host = {
    frames: [{ id: 'FRAME', url }], evaluations: [], disposed: 0,
    async listFrames() { return host.frames },
    async evaluateMainWorld(id, script) { host.evaluations.push(id); return page.evaluate(script) },
    async subscribeCdp(next) {
      if (!cdp) throw new Error('CDP_NOT_CONFIGURED')
      listener = next
      return async () => { listener = null; host.disposed++ }
    },
    frame(message) { listener?.({ method: 'Network.webSocketFrameReceived', params: {
      response: { opcode: 1, payloadData: JSON.stringify({ data: [{ message }] }) }
    } }) },
    event(event) { listener?.(event) }
  }
  return host
}
export class FakeTransport {
  sends = []
  async start(listener) { this.listener = listener; listener({ kind: 'status', ready: true }) }
  async send(input) {
    this.sends.push(input)
    if (this.onSend) return this.onSend(input)
    return { accepted: true, platformMessageId: `OUT-${this.sends.length}`, method: 'fake' }
  }
  async stop() { this.listener = null }
  message(id, buyer = 'A', source = 'live', extra = {}) {
    const now = Date.now()
    this.listener?.({ kind: 'message', source, hasTimestamp: true, message: {
      platformMessageId: id, buyerId: buyer, conversationId: `CONV-${buyer}`,
      direction: 'in', contentType: 'text', text: '同样文字', occurredAt: now, receivedAt: now, ...extra
    } })
  }
  manual(buyer = 'A') { this.listener?.({ kind: 'manual', buyerId: buyer, conversationId: `CONV-${buyer}` }) }
}
