import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  createPddGuestSendScript, parsePddGuestSendResult, decodeTitanPayload,
  extractPddCandidates, normalizePddCandidate, createDouyinPollScript,
  douyinSendScript, DOUYIN_DISPOSE_SCRIPT, normalizeDouyinMessage
} from '../src/index.js'
import { pddPage, dyPage, dyMessage } from './fixtures.js'

test('PDD: async signer, JSON argument escaping, text hash, auto flags and formal ID', async () => {
  const page = pddPage({ signature: async () => 'ASYNC_SIGNER' })
  const text = '引号"反斜线\\换行\n😀'
  const result = await page.evaluate(createPddGuestSendScript({ buyerId: 'BUYER', text, previousMessageId: 'IN' }))
  assert.equal(parsePddGuestSendResult(result).ok, true)
  const sent = page.calls[0]
  assert.equal(sent.body.data.message.content, text)
  assert.equal(sent.body.data.message.pre_msg_id, 'IN')
  assert.equal(sent.body.data.message.hash, createHash('sha256').update(text).digest('hex'))
  assert.equal(sent.body.data.message.is_aut, 1)
  assert.equal(sent.body.data.message.manual_reply, 0)
  assert.equal(sent.body.anti_content, 'ASYNC_SIGNER')
  assert.equal(sent.options.credentials, 'include')
  assert.ok(sent.options.signal instanceof AbortSignal)
})
test('PDD: HTTP 200 and a UI bubble are not acceptance', async () => {
  const page = pddPage({ response: { success: true, result: { result: 'ok' } } })
  const result = await page.evaluate(createPddGuestSendScript({ buyerId: 'BUYER', text: 'test' }))
  assert.equal(parsePddGuestSendResult(result).ok, false)
})
test('PDD: wrong origin and missing signer produce no fetch', async () => {
  const page = pddPage({ hostname: 'example.com' })
  await assert.rejects(page.evaluate(createPddGuestSendScript({ buyerId: 'A', text: 'test' })))
  assert.equal(page.calls.length, 0)
  const unsigned = pddPage({ signature: () => '' })
  await assert.rejects(unsigned.evaluate(createPddGuestSendScript({ buyerId: 'A', text: 'test' })))
  assert.equal(unsigned.calls.length, 0)
})
test('PDD: embedded gzip, duplicate IDs, UID role and unknown roles', () => {
  const message = { msg_id: 'IN', from: { role: 'user', uid: 'A' }, to: { role: 'mall_cs' }, type: 0, content: 'hello', ts: 1700000000 }
  const data = { seq_id: 8, data: [{ message }, { message }] }
  const bytes = Buffer.concat([Buffer.from([0, 10]), gzipSync(JSON.stringify(data)), Buffer.from([0, 1])])
  const values = decodeTitanPayload(bytes.toString('base64'), 2)
  assert.equal(values.length, 1)
  assert.equal(extractPddCandidates(values[0]).length, 1)
  const normalized = normalizePddCandidate(extractPddCandidates(values[0])[0], 'SHOP')
  assert.equal(normalized.buyerId, 'A')
  assert.equal(normalized.occurredAt, 1700000000000)
  assert.equal(normalizePddCandidate({ message: { ...message, from: { role: 'system', uid: 'A' } } }, 'SHOP'), undefined)
  assert.deepEqual(decodeTitanPayload('x'.repeat(2 * 1024 * 1024 + 1), 1), [])
})
test('Douyin: array history bug repaired and pigeonMsgType retained', () => {
  const page = dyPage()
  page.groups['CONV-A'] = [{ ...dyMessage('IN'), pigeonMsgType: 'file_image' }]
  const result = page.evaluate(createDouyinPollScript())
  assert.equal(result.ready, true)
  assert.equal(result.events.length, 1)
  assert.equal(normalizeDouyinMessage(result.events[0], 'SHOP').contentType, 'image')
  assert.equal(page.evaluate(createDouyinPollScript()).events.length, 0)
})
test('Douyin: native send has no manual event, real send has one', async () => {
  const page = dyPage()
  const original = page.im.sendText
  page.evaluate(createDouyinPollScript())
  const result = await page.evaluate(douyinSendScript('A', 'reply', Date.now()))
  assert.equal(result.ok, true)
  assert.equal(page.evaluate(createDouyinPollScript()).events.filter(event => event.kind === 'manual').length, 0)
  await page.im.sendText('CONV-A', 'manual')
  const manual = page.evaluate(createDouyinPollScript()).events.filter(event => event.kind === 'manual')
  assert.equal(manual.length, 1)
  assert.equal(manual[0].buyerId, 'A')
  page.evaluate(DOUYIN_DISPOSE_SCRIPT)
  assert.equal(page.im.sendText, original)
  assert.equal(page.callbacks.length, 0)
})
test('Douyin: missing/wrong buyer identity blocks send', async () => {
  const page = dyPage()
  page.im.chatWithUid = async () => { page.store.conversationsInfo.currentConversation = { id: 'WRONG', buyerId: 'A' } }
  page.evaluate(createDouyinPollScript())
  const result = await page.evaluate(douyinSendScript('B', 'test', Date.now()))
  assert.equal(result.ok, false)
  assert.equal(page.calls.length, 0)
})
test('Douyin: origin guard, inactive stale listener and clean reinstall', () => {
  assert.equal(dyPage({ hostname: 'example.com' }).evaluate(createDouyinPollScript()).ready, false)
  const page = dyPage({ noUnsubscribe: true })
  page.evaluate(createDouyinPollScript())
  const old = page.callbacks[0]
  page.evaluate(DOUYIN_DISPOSE_SCRIPT)
  old(dyMessage('OLD'))
  page.evaluate(createDouyinPollScript())
  assert.equal(page.evaluate(createDouyinPollScript()).events.length, 0)
  page.callbacks.at(-1)(dyMessage('NEW'))
  assert.equal(page.evaluate(createDouyinPollScript()).events.length, 1)
})
test('Douyin: timestamp arguments are encoded and cannot insert a script', async () => {
  const page = dyPage()
  page.evaluate(createDouyinPollScript())
  const result = await page.evaluate(douyinSendScript('A', 'reply', '0); window.INJECTED=true; (0'))
  assert.equal(result.ok, true)
  assert.equal(page.window.INJECTED, undefined)
})
test('Unsafe numeric message IDs are dropped rather than sent to a rounded ID', () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 100
  assert.equal(normalizePddCandidate({ message: { msg_id: unsafe, from: { role: 'user', uid: 'A' }, type: 0 } }, 'SHOP'), undefined)
  assert.equal(normalizeDouyinMessage({ message: { ...dyMessage('IN'), serverId: unsafe } }, 'SHOP'), undefined)
})
