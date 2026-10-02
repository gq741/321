export function timeout(promise, ms, code = 'TIMEOUT') {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms) })
  ]).finally(() => clearTimeout(timer))
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export const messageKey = (platform, storeId, messageId) => JSON.stringify([platform, storeId, messageId])
export function validateSend(input) {
  if (typeof input.buyerId !== 'string' || !input.buyerId.trim()) throw new Error('BUYER_ID_REQUIRED')
  if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('TEXT_REQUIRED')
}
export function allowedFrame(platform, url) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && (platform === 'pdd'
      ? parsed.hostname === 'mms.pinduoduo.com'
      : ['im.jinritemai.com', 'jsls.jinritemai.com'].includes(parsed.hostname))
  } catch { return false }
}
