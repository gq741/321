import { createStoreClient, createElectronHost, MemoryState, type PageHost } from 'shop-page-transport-kit'
import { createStoreClient as createRelativeClient } from '../src/index.js'

const host: PageHost = {
  async listFrames() { return [{ id: 'FRAME', url: 'https://mms.pinduoduo.com/chat' }] },
  async evaluateMainWorld(_frameId, _script) { return { ready: true } },
  async subscribeCdp(_listener) { return async () => {} }
}
const client = createStoreClient({
  platform: 'pdd', storeId: 'SHOP', host, state: new MemoryState(),
  decide: async ({ last, signal }) => signal.aborted ? null : last.text || null,
  onEvent(event) {
    if (event.kind === 'message') console.log(event.message.buyerId)
    if (event.kind === 'receipt') console.log(event.receipt.platformMessageId)
  }
})
createRelativeClient({ platform: 'douyin', storeId: 'SHOP_2', host })
void client.setAutoReply(false)
void client.resumeConversation('pdd:BUYER')
const guest = {
  isDestroyed: () => false,
  mainFrame: { processId: 1, routingId: 2, url: '', frames: [], executeJavaScript: async (_script: string) => ({}) },
  debugger: { isAttached: () => false, attach(_version?: string) {}, detach() {},
    async sendCommand(_method: string, _params?: unknown) { return {} },
    on(_event: string, _listener: (...args: unknown[]) => void) {},
    removeListener(_event: string, _listener: (...args: unknown[]) => void) {} }
}
createElectronHost(guest, 'douyin')
