# 页面收发复用包 V2

这次交付的是独立 **Node / Electron 收发库**，不是原项目快照。直接复制本目录或安装离线 `.tgz`，无需云监控原工程、`@shared` 别名、MockAdapter、Vue、Pinia、Playwright、原配置文件和原数据目录。

**运行源码零第三方依赖。** Node ≥ 20；测试使用 Node 自带 test / vm / crypto。Electron 由目标软件提供。Node 主进程使用本库，商家页面只执行页面桥；浏览器前端不要直接打包带 fs / zlib 的主进程模块。

## 1. 先验证，再接入

解压后在本目录运行：

```powershell
node --test tests/client.test.js tests/page.test.js tests/transport.test.js
node examples/offline-demo.js
```

两条命令无需安装依赖、无需登录店铺、没有真实消息发送。离线 demo 完整经过“合成 CDP 帧 → 解码 → 去重 → decide → MAIN-world 页面发送脚本 → 合成平台回执”，预期观察 1 条、重复 1 条、模拟发送 1 条、is_aut 为 1。

本库包入口是 `index.js`，它导出 `src/index.js` 中的模块；类型入口是 `index.d.ts`，直接相对引用 `src/index.js` 也有声明文件。不是原程序的 `src/main/index.ts`。**不要把整套原 Electron 工程一起搬进新程序。**

### 三种引用方式

```js
// 直接复制：在目标主进程按实际相对路径引用。
import { createStoreClient, createElectronHost, JsonFileState }
  from './vendor/shop-page-transport-kit/src/index.js'
```

```powershell
# 如使用本包提供的离线 tgz：在目标 Node / Electron 工程中安装。
npm install ./shop-page-transport-kit-2.0.0.tgz --offline --ignore-scripts --no-audit --no-fund
```

```js
// 安装后使用包名；CommonJS 主进程可用 await import('shop-page-transport-kit')。
import { createStoreClient } from 'shop-page-transport-kit'
```

离线 `.tgz` 放在交付压缩包的 `dist/` 中。npm 包只含运行源码、声明、示例和使用文档；完整 ZIP 另含本地测试及验证记录。

## 2. 实际收发方案

| 平台 | 接收 | 发送 |
|---|---|---|
| 拼多多 | 宿主提供 CDP `Network.webSocketFrameReceived`，Titan / gzip / JSON 标准化 | 在同一已登录 MAIN-world 页面调用 signer，正文 SHA-256，同页 fetch；is_aut=1、manual_reply=0 |
| 抖音 | MAIN-world Store / IM 事件、已加载消息扫描，宿主每 1500 ms 取队列 | 在同 frame 内 chatWithUid → 核验当前买家 → sendText → 正式 serverId 与业务字段核验 |

拼多多**仍使用 CDP 接收**，没有换成全程纯页面注入。此版不含旧 Playwright Chrome 分支，也没有为了纯注入接收引入旧 hook 的热身丢消息行为。

原页面内部接口的字段仍与平台版本有关；独立库的工程可复用性和真实平台当日的兼容性分开验证。新宿主需要最后做一次测试买家实收验收。

## 3. 最短 Electron 接入（调用你的既有 guest）

完整接线函数在 `examples/bind-electron-guest.js`。该例没有启动第二个浏览器，也没有登录弹窗逻辑；复用目标软件自己的商家 guest 和登录分区。

```js
import { bindShopWebContents } from './vendor/shop-page-transport-kit/examples/bind-electron-guest.js'

const client = await bindShopWebContents({
  guest: merchantGuestWebContents, // 商家页面的 guest，不是本地 UI 的 webContents
  platform: 'pdd',                 // 抖音填 'douyin'
  storeId: 'MY_STORE_A',           // 稳定、独立店铺标识
  dataDir: app.getPath('userData'),
  decide: async ({ messages, last, signal }) => {
    // 接入你现有的模板 / 数据库 / 模型处理层。
    // 返回字符串才发送，返回 null 表示本轮不自动答复。
    return yourReplyService({ messages, buyerId: last.buyerId, signal })
  },
  onEvent: event => yourExistingEventBus.emit('shop-transport', event)
})

// start 后始终自动回复关闭；仅在 ready 时由本地 UI 显式开启。
// 页面尚未就绪时，此调用抛出 WAIT_FOR_TRANSPORT_READY。
await client.setAutoReply(true)

// 人工介入后暂停对应会话，UI 显式恢复：
await client.resumeConversation('pdd:BUYER_UID') // 抖音：dy:真实CONVERSATION_ID

// 替换 guest / 切店 / 退出时：
await client.stop()
```

`onEvent` 是通知接口，不承担回复生成。它的异常和参数修改已与核心逻辑隔离。`decide` 只产生回复文字，也拿到隔离的消息副本；发送目标来自原入站消息，不采用处理层修改后的 uid。

### 对目标 Electron 宿主的要求

- 先有商家页面 WebContents；按平台白名单装载 HTTPS 页面。
- 本地窗口使用 `webviewTag: true`（如用 webview），商家 guest 使用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`。
- 不给商家 guest 装载本地 UI 的 preload，不向它暴露文件系统或通用 IPC。
- 每店独立、稳定的 `persist:` partition；每店仅绑定一个 client。
- 宿主创建分区 / guest、保存登录会话；库绑定已经创建的 guest，保持 MAIN-world 执行。
- 初次页面入口：PDD `https://mms.pinduoduo.com/chat-merchant/index.html`；DY `https://im.jinritemai.com/pc_seller_v2/main/workspace`。
- 多店用显式 `partition → platform/storeId/client` registry，不照搬原程序“非抖音默认分区都当拼多多”的判断。
- PDD 调试通道被其他调试器占用时抛出 `DEBUGGER_ALREADY_IN_USE`，避免抢占现有监听；DevTools / 调试组件与其共享或重连策略需由目标宿主设计。
- `createElectronHost` 会递归列出 frame；MAIN-world 执行前再次检查 frame URL。目标 UI 的 IPC 还应检查调用方、平台、店铺和参数。

## 4. 你已有自己的处理流水线：只接 transport

```js
import { PddTransport, createElectronHost } from './src/index.js'

const transport = new PddTransport({
  host: createElectronHost(merchantGuestWebContents, 'pdd'),
  storeId: 'MY_STORE_A'
})
await transport.start(event => existingReceivePipeline(event))

// transport 不负责业务去重 / 人工暂停；你的流水线完成这些校验后再调用。
const receipt = await transport.send({
  buyerId: originalInbound.buyerId,
  text: finalReply,
  inboundMessageId: originalInbound.platformMessageId,
  receivedAt: originalInbound.receivedAt
})
await transport.stop()
```

抖音换成 `DouyinTransport` 和 `'douyin'`。**二选一：** 使用 StoreClient 的去重 / 决策流水线，或 transport 接入既有流水线；避免两套流水线同时对同一入站发送。

## 5. 其他宿主怎样接

收发库当前运行于 Node / Electron 主进程。非 Electron 但有 Node 后端的宿主，实现下面的 PageHost 即可替换 `createElectronHost`：

```ts
interface PageHost {
  listFrames(): Promise<Array<{ id: string; url: string }>>;
  evaluateMainWorld(frameId: string, script: string): Promise<unknown>;
  subscribeCdp?(listener: (event: {
    method: string; params?: Record<string, unknown>
  }) => void): Promise<() => Promise<void>>;
}
```

- `evaluateMainWorld` 等待页面 Promise，回传 JSON 可序列化结果；不在隔离 content script 世界读取页面 IM。
- PDD 必须回传 CDP WebSocket 文本帧 / 二进制 base64 以及请求观察事件；抖音不要求 CDP。
- `subscribeCdp` 返回注销函数，并可用 `Host.detached` 事件通知捕获停止。
- 纯 C# / Python / 纯浏览器前端没有 Node 的 fs / zlib，需要接 Node 辅助进程或移植标准化 / 状态层。页面函数脚本可以复用，但此包没有假装为所有语言实现宿主桥。

## 6. 数据、开关、合并与人工暂停

| 项目 | V2 行为 |
|---|---|
| 仅观察 | 自动回复关闭仍回传文字、卡片、媒体标准化消息 |
| 去重 | 平台 + storeId + 平台消息 ID；同文字不同 ID 是不同消息 |
| 初始开关 | 每次 start 默认关闭，不受原工程 env / 历史开关影响 |
| OFF 期间消息 | 保存 observed，开启后不自动补回；历史补答须另定策略 |
| 合并 | PDD 默认 debounceMs=0；DY 默认 3500 ms；按会话独立合并 |
| 发送宽限 | PDD 默认 1200 ms；DY 100 ms，发送前再检查暂停 / 开关 |
| 发送顺序 | 每店串行，避免 DY 切会话串单；不同 client 可并行 |
| 人工介入 | manual 事件或非本程序的实时商家出站触发持久暂停 |
| 回显竞态 | 同买家在途回复先暂存回显，正式回执返回后按平台 ID 对账 |
| 历史商家消息 | 不当作“刚刚人工回复”持久暂停，仅抑制已被回答的历史消息 |
| 失败状态 | 未取得明确正式 ID 的提交记 unknown；没有双通道盲目重发 |
| 关闭 / stop | 清理定时器、取消待决策任务；已提交到 SDK / 网络的请求仍可能完成 |

人工发送入口覆盖仍依赖平台：PDD 观察 manual_reply 的 HTTP 与出站帧；DY 包装 sendText，恢复原函数并尽量解绑。SDK 没有 off 接口时，旧回调变为 inactive，避免继续产生事件；平台自身保留的回调引用可能仍占内存，刷新页面后清空。

不相同文本的实时商家出站会保守暂停；平台官方自动回复 / 别的插件也可能触发此策略，建议测试时只启用一个自动回复源。

### 状态保存

- MemoryState 只适用于离线 demo 或你已有持久层的测试。
- 正式运行用 JsonFileState，或实现同名 `snapshot/transact` 接口接数据库。
- JsonFileState 临时文件 + rename；读取损坏状态会报错停止接入，不清空去重数据后继续发送。
- 一个 JSON 状态文件仅一个写入实例 / 进程；多进程用数据库事务和唯一键。
- records 保留 10000 个 ID，超过窗口不是永久 exactly-once。持久记录包含买家 / 会话 / 消息 ID 与回执摘要，不含 signer / Cookie / 完整平台响应。
- 显式区分 `observed → deciding → sending → accepted / unknown / cancelled / failed / no-reply`。进程在提交与记回执之间退出也可能留下 unknown，需要人工核验或经验证的查询恢复。

## 7. 历史、卡片与能力边界

- DY 默认扫描当前已经载入的 Store 消息，主动尝试私有历史函数的 `pullHistory` **默认 false**；仅在目标版本验证后才开启。
- `recoverSince` 只决定已经收到的历史事件是否允许自动答复，默认 start 前 5 秒；它不保证拉到所有断线历史。主动历史读取涉及的未完成 Promise 也不是完整同步成功凭据。
- 非当前买家可由 IM 事件 / Store 最后一条消息发现，不需要先人工点击每个会话。
- 商品 / 订单卡识别是字段解析，不是商品全量采集，也不是抖音订单详情 API。
- 本包没有图片理解、视频理解、强制身份声明、知识库、意图包和 LLM。身份告知 / 真实业务事实由 decide 实现。
- 没有 WebDriver / visibility 等伪装脚本，不需要这类操作才能导入模块。
- `accepted` 表示平台业务成功并返正式 ID；`merchant-echo` 是商家回显；**买家实际收到另行核验**，不拿本地气泡作为到达证明。

## 8. 验收顺序

1. 新目录运行本地测试和离线 demo；确认导入时没有原工程依赖错误。
2. 接目标 guest，仅观察：校验平台、storeId、买家 UID、frame、消息方向与 ID。
3. 一条测试买家文本：正式回执 + 买家实收一条；PDD 核验 is_aut=1。
4. A/B 买家 + 停留 A 回复 B：确保无串单；重复平台 ID 只处理一次。
5. 人工回复、关闭开关、重启、断网和 SDK / frame 改变：验证取消、持久暂停和重连提示。

本库已做的离线验证与原代码改动记录见 `变更与验证.md`。请把 `接入提示词.md` 一并交给新程序开发 AI。
