import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PddTransport, DouyinTransport, createElectronHost } from '../src/index.js'
import { pddPage, dyPage, dyMessage, fakeHost } from './fixtures.js'

test('PDD transport: observation while reply is off, manual request, send and disposal', async () => {
  const page = pddPage()
  const host = fakeHost(page, 'https://mms.pinduoduo.com/chat-merchant/index.html', true)
  const events = []
  const transport = new PddTransport({ host, storeId: 'SHOP', pollMs: 999999 })
  try {
    await transport.start(event => events.push(event))
    host.frame({ msg_id: 'IN', type: 0, from: { role: 'user', uid: 'A' }, content: 'hello' })
    assert.equal(events.filter(event => event.kind === 'message').length, 1)
    host.event({ method: 'Network.requestWillBeSent', params: { request: {
      url: 'https://mms.pinduoduo.com/plateau/chat/send_message',
      postData: JSON.stringify({ data: { message: { manual_reply: 1, is_aut: 0, to: { uid: 'A' } } } })
    } } })
    assert.equal(events.filter(event => event.kind === 'manual').length, 1)
    const receipt = await transport.send({ buyerId: 'A', text: 'reply', inboundMessageId: 'IN' })
    assert.equal(receipt.accepted, true)
    assert.equal(page.calls[0].body.data.message.to.uid, 'A')
  } finally { await transport.stop() }
  assert.equal(host.disposed, 1)
  await assert.rejects(transport.send({ buyerId: 'A', text: 'test' }), /NOT_READY/)
})
test('PDD: lost CDP capture blocks sending and emits explicit status', async () => {
  const host = fakeHost(pddPage(), 'https://mms.pinduoduo.com/chat', true)
  const transport = new PddTransport({ host, storeId: 'SHOP', pollMs: 999999 })
  try {
    await transport.start(() => {})
    host.event({ method: 'Host.detached', params: {} })
    await assert.rejects(transport.send({ buyerId: 'A', text: 'test' }), /NOT_READY/)
  } finally { await transport.stop() }
})
test('Douyin transport: frame filtering, non-selected buyer, native receipt and disposal', async () => {
  const page = dyPage()
  const host = fakeHost(page, 'https://im.jinritemai.com/pc_seller_v2/main/workspace')
  host.frames.unshift({ id: 'BAD', url: 'https://example.com/iframe' })
  const transport = new DouyinTransport({ host, storeId: 'SHOP', pollMs: 999999 })
  const events = []
  try {
    await transport.start(event => events.push(event))
    page.callbacks[0](dyMessage('IN', 'B'))
    await transport.poll()
    assert.equal(events.find(event => event.kind === 'message').message.buyerId, 'B')
    const receipt = await transport.send({ buyerId: 'B', text: 'reply' })
    assert.equal(receipt.accepted, true)
    assert.equal(page.calls[0].id, 'CONV-B')
    assert.equal(host.evaluations.includes('BAD'), false)
  } finally { await transport.stop() }
  assert.equal(page.window.__shopTransportDyV2, undefined)
})
test('Electron host: nested frames, origin check, debugger conflict and cleanup', async () => {
  const child = { processId: 2, routingId: 3, url: 'https://im.jinritemai.com/main', frames: [], executeJavaScript: async () => 'result' }
  const middle = { processId: 2, routingId: 2, url: 'https://example.com/iframe', frames: [child] }
  const root = { processId: 1, routingId: 1, url: 'https://im.jinritemai.com/main', frames: [middle] }
  const debuggerObject = new EventEmitter()
  let attached = false
  Object.assign(debuggerObject, { isAttached: () => attached, attach: () => { attached = true },
    detach: () => { attached = false }, sendCommand: async () => {} })
  const guest = { mainFrame: root, isDestroyed: () => false, debugger: debuggerObject }
  const dyHost = createElectronHost(guest, 'douyin')
  assert.equal((await dyHost.listFrames()).length, 3)
  assert.equal(await dyHost.evaluateMainWorld('2:3', 'test'), 'result')
  await assert.rejects(dyHost.evaluateMainWorld('2:2', 'test'), /FRAME_OR_ORIGIN/)
  const pddHost = createElectronHost(guest, 'pdd')
  const dispose = await pddHost.subscribeCdp(() => {})
  assert.equal(debuggerObject.listenerCount('message'), 1)
  await assert.rejects(pddHost.subscribeCdp(() => {}), /ALREADY_IN_USE/)
  await dispose()
  assert.equal(attached, false)
  assert.equal(debuggerObject.listenerCount('message'), 0)
})
