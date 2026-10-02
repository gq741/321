// Runs in the seller page's main JavaScript world. Only normalized event fields cross into Electron.
export const DOUYIN_BRIDGE_SCRIPT = `(() => {
  const root = window;
  if (!['im.jinritemai.com','jsls.jinritemai.com'].includes(location.hostname)) return {ready:false, reason:'wrong_origin', events:[]};
  const pageText = document.body?.innerText || '';
  if (pageText.includes('登录过期')) return { ready: false, reason: 'login_expired', events: [] };
  if (pageText.includes('暂无会话权限')) return { ready: false, reason: 'permission_missing', events: [] };
  const context = root.__monaGlobalStore?.data?.initContextData;
  const im = context?.im;
  const store = context?.Store?.instance;
  if (!im || !store) return { ready: false, events: [] };
  let bridge = root.__shopTransportDyV2;
  if (!bridge || bridge.im !== im) {
    bridge?.dispose?.();
    const seen = new Set();
    const events = [];
    const object = (value) => value && typeof value === 'object' ? value : {};
    const value = (item) => item == null || (typeof item === 'number' && !Number.isSafeInteger(item)) ? '' : String(item).trim();
    const conversations = () => store.conversationsInfo?.conversationMap || {};
    const entries = (source) => source instanceof Map ? [...source.entries()] : Object.entries(source);
    const locate = (message, hint) => {
      const id = value(message?.securityConversationId || message?.conversationId || hint);
      for (const [, conversation] of entries(conversations())) {
        if (value(conversation?.id || conversation?.securityConversationId) === id) return conversation;
      }
      const current = store.conversationsInfo?.currentConversation;
      return !id || value(current?.id) === id ? current : undefined;
    };
    const ingest = (message, hint, source = 'history') => {
      if (!bridge?.active || !message || typeof message !== 'object') return;
      const ext = object(message.ext);
      const role = value(ext.sender_role);
      if (role !== '1' && role !== '2') return;
      const messageId = value(message.serverId || message.id);
      if (!messageId || seen.has(messageId)) return;
      const conversation = locate(message, hint);
      const conversationId = value(message.securityConversationId || message.conversationId || conversation?.id || hint);
      const buyerId = value(conversation?.buyerId || ext.buyer_id || ext.buyerId ||
        (role === '1' ? message.securitySender || message.sender : ''));
      if (!conversationId || !buyerId) return;
      if (source === 'live') bridge.lastLiveAt = Date.now();
      seen.add(messageId);
      if (seen.size > 12000) seen.delete(seen.values().next().value);
      events.push({ kind: 'message', source, buyerId, conversationId, message: {
        serverId: messageId,
        securityConversationId: conversationId,
        securitySender: message.securitySender,
        sender: message.sender,
        content: message.content,
        createTime: message.createTime,
        timestamp: message.timestamp || message.ts || message.time,
        pigeonMsgType: message.pigeonMsgType,
        type: message.type,
        ext: { sender_role: role, type: ext.type, buyer_id: ext.buyer_id, buyerId: ext.buyerId,
          's:client_message_id': ext['s:client_message_id'], goods_id: ext.goods_id,
          order_id: ext.order_id, card_id: ext.card_id, card_header: ext.card_header,
          static_data: ext.static_data, generic_search_keywords: ext.generic_search_keywords }
      }});
      if (events.length > 5000) events.splice(0, events.length - 5000);
    };
    const pullHistory = (conversation) => {
      const id = value(conversation?.id);
      if (!id) return;
      const now = Date.now();
      if (now - (bridge.historyAt.get(id) || 0) < 8000) return;
      bridge.historyAt.set(id, now);
      const methods = ['getMessagesByConversation', 'getHistoryMessages', 'loadHistoryMessages',
        'fetchHistoryMessages', 'getMessageList', 'getMessages', 'loadMessages', 'pullHistoryMessage'];
      const args = [id, { conversationId: id, conversation, limit: 30, count: 30 }, conversation];
      for (const target of [im, im.pigeonIM].filter(Boolean)) {
        for (const name of methods) {
          const fn = target[name];
          if (typeof fn !== 'function') continue;
          for (const arg of args) {
            try {
              const result = fn.call(target, arg);
              if (result == null) continue;
              bridge.historyPending++;
              Promise.resolve(result).then((response) => {
                bridge.historyVerifiedAt = Date.now();
                const list = Array.isArray(response) ? response :
                  Array.isArray(response?.messages) ? response.messages :
                  Array.isArray(response?.data?.messages) ? response.data.messages : [];
                for (const message of list.slice(-30)) ingest(message, id);
                scan(false);
              }).catch(() => {}).finally(() => { bridge.historyPending--; });
              return;
            } catch { /* Try the next signature. */ }
          }
        }
      }
    };
    const scan = (withHistory = false) => {
      if (!bridge?.active) return;
      for (const [key, conversation] of entries(conversations()).slice(0, 250)) {
        ingest(conversation?.lastMessage, key);
      }
      const groups = store.conversationsInfo?.messagesByConversationId || {};
      for (const [key, messages] of entries(groups).slice(0, 250)) {
        const source = Array.isArray(messages) || messages instanceof Map ? messages : messages?.map || messages;
        const list = Array.isArray(source) ? source : source instanceof Map ? [...source.values()] :
          Array.isArray(messages?.messages) ? messages.messages :
          Array.isArray(messages?.messageList) ? messages.messageList : [];
        for (const message of list.slice(-30)) ingest(message, key);
      }
      if (!withHistory || Date.now() - bridge.lastHistorySweep < 15000) return;
      bridge.lastHistorySweep = Date.now();
      const candidates = entries(conversations()).map(([, conversation]) => conversation)
        .filter((conversation) => conversation?.buyerId &&
          (Number(conversation.unreadCount || 0) > 0 ||
            value(conversation.lastMessage?.ext?.sender_role) === '1'));
      for (let offset = 0; offset < Math.min(6, candidates.length); offset++) {
        const index = (bridge.historyCursor + offset) % candidates.length;
        pullHistory(candidates[index]);
      }
      if (candidates.length) bridge.historyCursor = (bridge.historyCursor + 6) % candidates.length;
    };
    bridge = {
      im,
      active: true,
      cleanups: [],
      manualAt: new Map(),
      historyAt: new Map(),
      historyCursor: 0,
      historyPending: 0,
      historyVerifiedAt: 0,
      lastLiveAt: 0,
      lastHistorySweep: 0,
      scan,
      drain() { return events.splice(0, 500); },
      async send(uid, text, receivedAt) {
        if (typeof im.chatWithUid !== 'function' || typeof im.sendText !== 'function')
          return { ok: false, message: '飞鸽页面发送接口尚未就绪' };
        await im.chatWithUid(uid);
        const current = store.conversationsInfo?.currentConversation;
        const currentBuyer = value(current?.buyerId);
        if (!currentBuyer || currentBuyer !== uid)
          return { ok: false, message: '当前会话与目标买家不一致' };
        const conversationId = value(current?.id);
        if (!conversationId) return { ok: false, message: '未取得飞鸽会话 ID' };
        if ((bridge.manualAt.get(conversationId) || 0) > receivedAt)
          return { ok: false, message: '人工已回复，已取消自动发送' };
        bridge.ownSend = true;
        let promise;
        try { promise = im.sendText(conversationId, text); }
        finally { bridge.ownSend = false; }
        const response = await promise;
        const ext = object(response?.ext);
        const platformMessageId = value(response?.serverId);
        const ok = Boolean(platformMessageId) && Number(response?.flightStatus) === 3 &&
          Number(response?.serverStatus) === 0 &&
          value(ext['s:send_response_status']) === '0' &&
          value(ext['s:send_response_check_code']) === '0';
        return { ok, conversationId, platformMessageId,
          message: ok ? '服务端返回正式消息 ID' : '飞鸽未返回成功回执' };
      }
    };
    root.__shopTransportDyV2 = bridge;
    const originalSendText = im.sendText;
    let wrappedSendText;
    if (typeof originalSendText === 'function') {
      im.sendText = wrappedSendText = function (...args) {
        if (bridge.active && !bridge.ownSend) {
          const current = store.conversationsInfo?.currentConversation;
          const conversationId = value(args[0] || current?.id);
          const buyerId = value(current?.buyerId);
          if (buyerId && conversationId) {
            bridge.manualAt.set(conversationId, Date.now());
            events.push({ kind: 'manual', buyerId, conversationId, at: Date.now() });
          }
        }
        return originalSendText.apply(this, args);
      };
    }
    for (const name of ['onMessage', 'onMessageChange']) {
      if (typeof im[name] !== 'function') continue;
      const callback = (message) => ingest(message, undefined, 'live');
      const unsubscribe = im[name](callback);
      if (typeof unsubscribe === 'function') bridge.cleanups.push(unsubscribe);
      else {
        const off = name === 'onMessage' ? 'offMessage' : 'offMessageChange';
        if (typeof im[off] === 'function') bridge.cleanups.push(() => im[off](callback));
      }
    }
    bridge.dispose = () => {
      bridge.active = false;
      if (im.sendText === wrappedSendText) im.sendText = originalSendText;
      for (const cleanup of bridge.cleanups) { try { cleanup(); } catch {} }
      events.length = 0;
      if (root.__shopTransportDyV2 === bridge) delete root.__shopTransportDyV2;
    };
  }
  bridge.scan(false);
  return { ready: true, historyPending: bridge.historyPending,
    verifiedAt: Math.max(bridge.historyVerifiedAt, bridge.lastLiveAt), events: bridge.drain() };
})()`;
export const douyinSendScript = (buyerId, text, receivedAt) => `window.__shopTransportDyV2.send(${JSON.stringify(buyerId)}, ${JSON.stringify(text)}, ${JSON.stringify(Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : Date.now())})`;
export function createDouyinPollScript(options = {}) {
    return DOUYIN_BRIDGE_SCRIPT.replace('bridge.scan(false);', 'bridge.scan(' + Boolean(options.pullHistory) + ');');
}
export const DOUYIN_DISPOSE_SCRIPT = "(() => { window.__shopTransportDyV2?.dispose?.(); return true; })()";
