import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createElectronHost, createStoreClient, JsonFileState } from '../src/index.js'

// Call from the TARGET APP's main process after its guest WebContents is created.
// guest is the merchant webContents, not the local dashboard webContents.
export async function bindShopWebContents({ guest, platform, storeId, dataDir, decide, onEvent }) {
  const fileName = createHash('sha256').update(storeId).digest('hex') + '.json'
  const host = createElectronHost(guest, platform)
  const client = createStoreClient({
    platform, storeId, host,
    state: new JsonFileState(join(dataDir, 'shop-transport', platform, fileName)),
    decide, onEvent
  })
  await client.start() // Always observe-only initially.
  guest.once('destroyed', () => { void client.stop().catch(() => {}) })
  return client
}

// UI binding in the target application:
// const client = await bindShopWebContents({ guest, platform: 'pdd', storeId: 'STORE_A',
//   dataDir: app.getPath('userData'), decide: yourExistingReplyService, onEvent: yourEventHandler })
// Enable from a trusted local UI, after client.getStatus().ready === true:
// await client.setAutoReply(true)
// Human pause is per conversation; resume only through an explicit UI action:
// await client.resumeConversation('pdd:BUYER_ID')
// await client.stop() before replacing or reattaching this guest.
