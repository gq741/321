import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createStoreClient, MemoryState, JsonFileState } from '../src/index.js'
import { FakeTransport } from './fixtures.js'

const setup = (extra = {}) => {
  const transport = extra.transport || new FakeTransport()
  const state = extra.state || new MemoryState()
  const events = []
  const client = createStoreClient({ platform: 'pdd', storeId: 'SHOP', transport, state,
    graceMs: 0, debounceMs: 0, decide: async () => 'reply', onEvent: event => events.push(event), ...extra })
  return { client, transport, state, events }
}
test('client: starts OFF, observes messages, enabling does not resend OFF-time history', async () => {
  const { client, transport, events } = setup()
  await client.start()
  assert.equal(client.getStatus().autoReply, false)
  transport.message('OFF')
  await client.flush()
  assert.equal(transport.sends.length, 0)
  assert.equal(events.filter(event => event.kind === 'message').length, 1)
  await client.setAutoReply(true)
  transport.message('OFF')
  await client.flush()
  assert.equal(transport.sends.length, 0)
  await client.stop()
})
test('client: same ID is deduped; same text with a different ID is a distinct message', async () => {
  const { client, transport, events } = setup()
  await client.start(); await client.setAutoReply(true)
  transport.message('IN-1'); transport.message('IN-1'); transport.message('IN-2')
  await client.flush()
  assert.equal(transport.sends.length, 2)
  assert.equal(events.filter(event => event.kind === 'duplicate').length, 1)
  await client.stop()
})
test('client: store ID is part of the persistent dedup key', async () => {
  const state = new MemoryState()
  const a = setup({ state, storeId: 'SHOP-A' })
  const b = setup({ state, storeId: 'SHOP-B' })
  for (const item of [a, b]) {
    await item.client.start(); await item.client.setAutoReply(true)
    item.transport.message('SAME-ID')
    await item.client.flush()
    assert.equal(item.transport.sends.length, 1)
    await item.client.stop()
  }
  assert.equal(Object.keys((await state.snapshot()).records).length, 2)
})
test('client: two buyers are sent sequentially to their exact buyer IDs', async () => {
  const { client, transport } = setup()
  let active = 0, peak = 0
  transport.onSend = async input => {
    active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    return { accepted: true, platformMessageId: `OUT-${input.buyerId}` }
  }
  await client.start(); await client.setAutoReply(true)
  transport.message('A1', 'A'); transport.message('B1', 'B')
  await client.flush()
  assert.deepEqual(transport.sends.map(input => input.buyerId), ['A', 'B'])
  assert.equal(peak, 1)
  await client.stop()
})
test('client: per-conversation merge saves a receipt mapping for every inbound ID', async () => {
  const { client, transport, state } = setup({ platform: 'douyin', debounceMs: 99999 })
  await client.start(); await client.setAutoReply(true)
  for (const id of ['1', '2', '3']) transport.message(id)
  await client.flush()
  assert.equal(transport.sends.length, 1)
  const records = Object.values((await state.snapshot()).records)
  assert.equal(records.length, 3)
  assert.ok(records.every(record => record.receipt.platformMessageId === 'OUT-1'))
  await client.stop()
})
test('client: manual reply during an async decision cancels sending and remains paused', async () => {
  let resolveDecision, started
  const began = new Promise(resolve => { started = resolve })
  const { client, transport, state } = setup({ decide: async () => {
    started()
    return new Promise(resolve => { resolveDecision = resolve })
  } })
  await client.start(); await client.setAutoReply(true)
  transport.message('IN')
  const flush = client.flush()
  await began
  transport.manual()
  resolveDecision('reply')
  await flush
  assert.equal(transport.sends.length, 0)
  assert.equal((await state.snapshot()).paused.length, 1)
  transport.message('AFTER')
  await client.flush()
  assert.equal(transport.sends.length, 0)
  await client.stop()
})
test('client: own echo arriving before send return does not create manual pause', async () => {
  const { client, transport, state, events } = setup()
  transport.onSend = async input => {
    transport.message('OUT', 'A', 'live', { direction: 'out', text: input.text })
    return { accepted: true, platformMessageId: 'OUT' }
  }
  await client.start(); await client.setAutoReply(true)
  transport.message('IN')
  await client.flush()
  assert.equal((await state.snapshot()).paused.length, 0)
  assert.equal(events.filter(event => event.kind === 'merchant-echo').length, 1)
  await client.stop()
})
test('client: old merchant history is not a new permanent manual pause', async () => {
  const { client, transport, state } = setup()
  await client.start(); await client.setAutoReply(true)
  transport.message('OLD-OUT', 'A', 'history', { direction: 'out', occurredAt: Date.now() - 60000 })
  transport.message('NEW-IN')
  await client.flush()
  assert.equal(transport.sends.length, 1)
  assert.equal((await state.snapshot()).paused.length, 0)
  await client.stop()
})
test('client: stale history and media are observed but not automatically answered', async () => {
  const { client, transport, events } = setup()
  await client.start(); await client.setAutoReply(true)
  transport.message('OLD', 'A', 'history', { occurredAt: Date.now() - 60000 })
  transport.message('IMAGE', 'A', 'live', { contentType: 'image' })
  await client.flush()
  assert.equal(transport.sends.length, 0)
  assert.equal(events.filter(event => event.kind === 'message').length, 2)
  await client.stop()
})
test('client: unknown send outcome stays deduped after a restart, with no blind fallback', async () => {
  const state = new MemoryState()
  const first = setup({ state })
  first.transport.onSend = async () => { throw new Error('SEND_RESULT_UNKNOWN') }
  await first.client.start(); await first.client.setAutoReply(true)
  first.transport.message('IN')
  await first.client.flush(); await first.client.stop()
  assert.equal(Object.values((await state.snapshot()).records)[0].status, 'unknown')
  const second = setup({ state })
  await second.client.start(); await second.client.setAutoReply(true)
  second.transport.message('IN')
  await second.client.flush()
  assert.equal(second.transport.sends.length, 0)
  await second.client.stop()
})
test('client: throwing consumer hooks do not break observation or sending', async () => {
  const { client, transport } = setup({ onEvent() { throw new Error('UI_ERROR') } })
  await client.start(); await client.setAutoReply(true)
  transport.message('IN')
  await client.flush()
  assert.equal(transport.sends.length, 1)
  await client.stop()
})
test('client: consumer mutation does not change the transport buyer or message ID', async () => {
  const { client, transport } = setup({
    onEvent(event) { if (event.kind === 'message') event.message.buyerId = 'WRONG' },
    decide({ last }) { last.buyerId = 'WRONG'; return 'reply' }
  })
  await client.start(); await client.setAutoReply(true)
  transport.message('IN', 'A')
  await client.flush()
  assert.equal(transport.sends[0].buyerId, 'A')
  assert.equal(transport.sends[0].inboundMessageId, 'IN')
  await client.stop()
})
test('client: persistent manual pause survives restart; explicit resume affects only its conversation', async () => {
  const state = new MemoryState()
  const first = setup({ state })
  await first.client.start(); await first.client.pauseConversation('CONV-A'); await first.client.stop()
  const next = setup({ state })
  await next.client.start(); await next.client.setAutoReply(true)
  next.transport.message('A1', 'A'); next.transport.message('B1', 'B')
  await next.client.flush()
  assert.deepEqual(next.transport.sends.map(input => input.buyerId), ['B'])
  await next.client.resumeConversation('CONV-A')
  next.transport.message('A2', 'A')
  await next.client.flush()
  assert.deepEqual(next.transport.sends.map(input => input.buyerId), ['B', 'A'])
  await next.client.stop()
})
test('client: stopping or disconnecting cancels buffered replies', async () => {
  const { client, transport } = setup({ debounceMs: 99999 })
  await client.start(); await client.setAutoReply(true)
  transport.message('IN')
  await client.receiveQueue
  transport.listener({ kind: 'status', ready: false })
  await client.flush(); await client.stop()
  assert.equal(transport.sends.length, 0)
})
test('JSON state: atomic save and re-open; corrupt state fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-kit-state-'))
  try {
    const file = join(directory, 'state.json')
    const first = new JsonFileState(file)
    await first.transact(draft => { draft.paused.push('KEY') })
    assert.deepEqual((await new JsonFileState(file).snapshot()).paused, ['KEY'])
    await writeFile(file, '{BROKEN', 'utf8')
    const { client, transport } = setup({ state: new JsonFileState(file) })
    await assert.rejects(client.start())
    assert.equal(transport.listener, undefined)
  } finally {
    // Verify the exact disposable fixture directory before recursive cleanup.
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.includes('shop-kit-state-')) throw new Error('INVALID_TEST_CLEANUP_PATH')
    await rm(directory, { recursive: true, force: true })
  }
})
