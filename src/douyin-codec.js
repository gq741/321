const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const string = (value) => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const jsonObject = (value) => {
    if (typeof value !== 'string')
        return object(value);
    try {
        return object(JSON.parse(value));
    }
    catch {
        return {};
    }
};
const BEHAVIOR_TEXTS = new Set(['用户正在查看商品', '用户进入了商品详情页']);
export function shouldQueueDouyinReply(message, source, hasTimestamp, recoveryCutoff, lastMerchantAt) {
    return (message.direction === 'in' &&
        message.contentType === 'text' &&
        Boolean(message.text) &&
        !BEHAVIOR_TEXTS.has(message.text || '') &&
        (source !== 'history' || hasTimestamp) &&
        message.occurredAt >= recoveryCutoff &&
        lastMerchantAt < message.occurredAt);
}
export function normalizeDouyinMessage(input, profileId, receivedAt = Date.now()) {
    const raw = object(input.message);
    const ext = object(raw.ext);
    const role = string(ext.sender_role);
    if (role !== '1' && role !== '2')
        return undefined;
    if (typeof (raw.serverId || raw.id) === 'number' && !Number.isSafeInteger(raw.serverId || raw.id))
        return undefined;
    const platformMessageId = string(raw.serverId || raw.id);
    if (!platformMessageId)
        return undefined;
    const buyerId = string(input.buyerId ||
        ext.buyer_id ||
        ext.buyerId ||
        (role === '1' ? raw.securitySender || raw.sender : ''));
    if (!buyerId)
        return undefined;
    const conversationId = string(input.conversationId || raw.securityConversationId || raw.conversationId);
    if (!conversationId)
        return undefined;
    const content = object(raw.content);
    const rawType = string(raw.pigeonMsgType || ext.type || 'text');
    const cardHeader = jsonObject(ext.card_header);
    const cardScene = string(cardHeader.cardSourceScene);
    const staticData = jsonObject(ext.static_data);
    const saleGoods = Array.isArray(staticData.sale_goods) ? object(staticData.sale_goods[0]) : {};
    const text = string((typeof raw.content === 'string' ? raw.content : undefined) ||
        content.text ||
        content.content ||
        raw.text ||
        raw.msg).replace(/\s+/g, ' ');
    const time = Number(raw.createTime || raw.timestamp || raw.ts || raw.time);
    const occurredAt = Number.isFinite(time) && time > 1e12
        ? time
        : Number.isFinite(time) && time > 1e9
            ? time * 1000
            : receivedAt;
    const contentType = rawType === 'text'
        ? 'text'
        : rawType === 'file_image'
            ? 'image'
            : rawType === 'video'
                ? 'video'
                : rawType === 'template_card'
                    ? string(ext.order_id) || cardScene === 'order_card'
                        ? 'order_card'
                        : string(ext.goods_id) || cardScene === 'goods_card_v2'
                            ? 'goods_card'
                            : 'system'
                    : 'system';
    return {
        id: `dy-${profileId}-${platformMessageId}`,
        platformId: 'douyin-feige',
        profileId,
        conversationId: `dy:${conversationId}`,
        platformMessageId,
        buyerId,
        direction: role === '1' ? 'in' : 'out',
        contentType,
        rawType,
        text,
        orderId: contentType === 'order_card' ? string(ext.order_id) || undefined : undefined,
        goodsId: contentType === 'goods_card' ? string(ext.goods_id) || undefined : undefined,
        goodsTitle: contentType === 'goods_card'
            ? string(saleGoods.product_name_two_lines || saleGoods.product_name) || undefined
            : contentType === 'order_card'
                ? string(staticData.product_name || object(staticData.b_good).product_name) || undefined
                : undefined,
        skuText: contentType === 'goods_card' ? string(saleGoods.sku) || undefined : undefined,
        rawOrderStatus: contentType === 'order_card' ? string(staticData.order_status) || undefined : undefined,
        receivedSequence: receivedAt,
        occurredAt,
        receivedAt
    };
}
