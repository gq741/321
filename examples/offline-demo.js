import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { createStoreClient, MemoryState } from '../src/index.js'

console.log('离线模拟：以下页面和平台回执均为本地 fixture，没有打开店铺或发送真实消息。')
let receiveCdp
const sent = []
const state = { userInfo: { mall_id: 'DEMO_MALL' }, riskControlCrawler: { messagePack: async () => 'DEMO_SIGNATURE' } }
const context = vm.createContext({ window: {}, location: { hostname: 'mms.pinduoduo.com' },
  document: { querySelector: () => ({ __vue__: { $store: { state } } }) },
  crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout,
  fetch: async (_url, options) => {
    sent.push(JSON.parse(options.body).data.message)
    return { ok: true, status: 200, json: async () => ({ success: true,
      result: { result: 'ok', msg_id: `DEMO_OUT_${sent.length}` } }) }
  }
})
const host = {
  async listFrames() { return [{ id: 'DEMO_FRAME', url: 'https://mms.pinduoduo.com/chat-merchant/index.html' }] },
  async evaluateMainWorld(_id, script) { return vm.runInContext(script, context) },
  async subscribeCdp(listener) { receiveCdp = listener; return async () => { receiveCdp = null } }
}
const events = []
const client = createStoreClient({ platform: 'pdd', storeId: 'DEMO_STORE', host,
  state: new MemoryState(), graceMs: 0,
  decide: async ({ last }) => `您好，我是智能客服小助手。已收到：${last.text}`,
  onEvent: event => { events.push(event); console.log('事件：', event.kind) }
})
try {
  await client.start()
  await client.setAutoReply(true)
  const message = { msg_id: 'DEMO_IN_1', type: 0, from: { role: 'user', uid: 'DEMO_BUYER' },
    content: '请问如何联系客服？', ts: Math.floor(Date.now() / 1000) }
  const frame = { method: 'Network.webSocketFrameReceived', params: { response: {
    opcode: 1, payloadData: JSON.stringify({ data: [{ message }] })
  } } }
  receiveCdp(frame)
  receiveCdp(frame)
  await client.flush()
  console.log(JSON.stringify({ inboundObservations: events.filter(event => event.kind === 'message').length,
    duplicates: events.filter(event => event.kind === 'duplicate').length,
    simulatedSends: sent.length, is_aut: sent[0]?.is_aut, receipt: events.find(event => event.kind === 'receipt')?.receipt }, null, 2))
  if (sent.length !== 1 || sent[0].is_aut !== 1) throw new Error('OFFLINE_DEMO_FAILED')
} finally { await client.stop() }
