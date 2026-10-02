import { allowedFrame } from './util.js'

// No electron import: the target application supplies its own WebContents instance.
export function createElectronHost(guest, platform) {
  if (!['pdd', 'douyin'].includes(platform)) throw new Error('PLATFORM_REQUIRED')
  let subscribed = false
  const frames = () => {
    if (guest.isDestroyed()) return []
    const output = []
    const visit = frame => {
      output.push(frame)
      for (const child of frame.frames || []) visit(child)
    }
    visit(guest.mainFrame)
    return output
  }
  const frameId = frame => `${frame.processId}:${frame.routingId}`
  return {
    async listFrames() {
      return frames().map(frame => ({ id: frameId(frame), url: frame.url }))
    },
    async evaluateMainWorld(id, script) {
      const frame = frames().find(item => frameId(item) === id)
      if (!frame || !allowedFrame(platform, frame.url)) throw new Error('FRAME_OR_ORIGIN_CHANGED')
      return frame.executeJavaScript(script)
    },
    async subscribeCdp(listener) {
      if (platform !== 'pdd') throw new Error('CDP_ONLY_USED_FOR_PDD')
      if (subscribed || guest.debugger.isAttached()) throw new Error('DEBUGGER_ALREADY_IN_USE')
      guest.debugger.attach('1.3')
      subscribed = true
      const handle = (_event, method, params) => listener({ method, params })
      const detached = (_event, reason) => listener({ method: 'Host.detached', params: { reason } })
      guest.debugger.on('message', handle)
      guest.debugger.on('detach', detached)
      const dispose = async () => {
        if (!subscribed) return
        subscribed = false
        guest.debugger.removeListener('message', handle)
        guest.debugger.removeListener('detach', detached)
        if (!guest.isDestroyed() && guest.debugger.isAttached()) guest.debugger.detach()
      }
      try {
        await guest.debugger.sendCommand('Network.enable', {
          maxTotalBufferSize: 20 * 1024 * 1024,
          maxResourceBufferSize: 2 * 1024 * 1024
        })
      } catch (error) { await dispose(); throw error }
      return dispose
    }
  }
}
