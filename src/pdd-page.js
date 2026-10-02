// Runs in the same logged-in webview that receives the buyer message.
export function createPddGuestSendScript(input) {
    return `(async () => {
    const buyerId = ${JSON.stringify(input.buyerId)};
    const text = ${JSON.stringify(input.text)};
    const previousMessageId = ${JSON.stringify(input.previousMessageId || '')};
    if (location.hostname !== 'mms.pinduoduo.com') throw new Error('拼多多客服页地址不匹配。');
    const root = document.querySelector('#app');
    const state = root?.__vue__?.$store?.state || {};
    const crawler = window.riskControlCrawler || state.riskControlCrawler || state.IMSDK?.riskControlCrawler;
    const mallId = String(window.global_mall_id || state.userInfo?.mall_id || '');
    if (!mallId) throw new Error('当前客服页尚未取得店铺身份。');
    if (!crawler || typeof crawler.messagePack !== 'function') throw new Error('页面签名器尚未就绪。');
    if (typeof crawler.updateServerTime === 'function') {
      crawler.updateServerTime((window.SERVER_DIFF_TIME || 0) + Date.now());
    }
    const anti = await crawler.messagePack() || '';
    if (!anti) throw new Error('页面未生成 anti-content。');
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
    const ts = Math.floor(Date.now() / 1000);
    const requestId = Date.now();
    const body = {
      data: {
        cmd: 'send_message',
        anti_content: anti,
        request_id: requestId,
        message: {
          to: { role: 'user', uid: buyerId },
          from: { role: 'mall_cs' },
          ts,
          content: text,
          msg_id: null,
          ...(previousMessageId ? { pre_msg_id: previousMessageId } : {}),
          type: 0,
          is_aut: 1,
          manual_reply: 0,
          status: 'read',
          is_read: 1,
          hash
        },
        random: crypto.randomUUID().replace(/-/g, '')
      },
      client: 'WEB',
      anti_content: anti
    };
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 10000);
    let response, data;
    try {
    response = await fetch('https://mms.pinduoduo.com/plateau/chat/send_message', {
      signal: controller.signal,
      method: 'POST',
      credentials: 'include',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
        'anti-content': String(anti)
      },
      body: JSON.stringify(body)
    });
    data = await response.json().catch(() => null);
    } finally { clearTimeout(abortTimer); }
    const result = data?.result || {};
    const platformMessageId = result.msg_id == null ? undefined : String(result.msg_id);
    const returnedPreviousMessageId = result.pre_msg_id == null ? undefined : String(result.pre_msg_id);
    const linked = !returnedPreviousMessageId || !previousMessageId || returnedPreviousMessageId === previousMessageId;
    const ok = response.ok && data?.success === true && result.result === 'ok' && Boolean(platformMessageId);
    return {
      ok,
      status: response.status,
      platformMessageId,
      previousMessageId: returnedPreviousMessageId,
      timestamp: Number(result.ts || ts),
      code: String(data?.error_code || result.error_code || response.status),
      message: data?.error_msg || data?.errorMsg || result.error_msg ||
        (!platformMessageId ? '平台响应缺少 msg_id。' :
          !linked ? '平台返回的上一条消息 ID 与入站不同；已取得正式消息 ID，待买家端核验。' : undefined),
      method: 'page.fetch',
      antiLength: String(anti).length,
      mallId
    };
  })()`;
}
export function parsePddGuestSendResult(value) {
    if (!value || typeof value !== 'object')
        throw new Error('页面发送结果格式错误。');
    const result = value;
    return {
        ok: result.ok === true && Boolean(result.platformMessageId),
        status: Number(result.status || 0),
        platformMessageId: result.platformMessageId == null ? undefined : String(result.platformMessageId),
        previousMessageId: result.previousMessageId == null ? undefined : String(result.previousMessageId),
        timestamp: Number(result.timestamp || 0),
        code: result.code == null ? undefined : String(result.code),
        message: result.message == null ? undefined : String(result.message),
        method: String(result.method || 'page.fetch'),
        antiLength: Number(result.antiLength || 0),
        mallId: result.mallId == null ? undefined : String(result.mallId)
    };
}
