export type Platform = 'pdd' | 'douyin';
export interface Message {
  platformMessageId: string; buyerId: string; conversationId: string;
  direction: 'in' | 'out'; contentType: string; text?: string;
  occurredAt: number; receivedAt: number; profileId?: string; platformId?: string;
  orderId?: string; goodsId?: string; goodsTitle?: string; skuText?: string;
  mediaUrl?: string; rawOrderStatus?: string; source?: 'live' | 'history';
}
export interface SendInput { buyerId: string; text: string; inboundMessageId?: string; receivedAt?: number }
export interface Receipt {
  accepted: boolean; outcome?: 'accepted' | 'unknown'; platformMessageId?: string;
  method?: string; code?: string; message?: string; at?: number;
}
export type TransportEvent =
  | { kind: 'message'; message: Message; source?: 'live' | 'history'; hasTimestamp?: boolean }
  | { kind: 'manual'; buyerId: string; conversationId: string; at?: number }
  | { kind: 'status'; ready: boolean; reason?: string };
export type ClientEvent = TransportEvent
  | { kind: 'receipt'; messageIds: string[]; receipt: Receipt }
  | { kind: 'merchant-echo'; message: Message }
  | { kind: 'duplicate'; messageId: string }
  | { kind: 'paused'; conversationId: string }
  | { kind: 'auto-reply'; enabled: boolean }
  | { kind: 'error'; code?: string; message: string };
export interface PageHost {
  listFrames(): Promise<Array<{ id: string; url: string }>>;
  evaluateMainWorld(frameId: string, script: string): Promise<unknown>;
  subscribeCdp?(listener: (event: { method: string; params?: Record<string, unknown> }) => void): Promise<() => Promise<void>>;
}
export interface Transport {
  start(listener: (event: TransportEvent) => void): Promise<void>;
  send(input: SendInput): Promise<Receipt>;
  stop(): Promise<void>;
}
export interface TransportOptions {
  host: PageHost; storeId: string; pollMs?: number; timeoutMs?: number; pullHistory?: boolean;
}
export class PddTransport implements Transport {
  constructor(options: TransportOptions); ready: boolean;
  start(listener: (event: TransportEvent) => void): Promise<void>;
  poll(): Promise<void>; send(input: SendInput): Promise<Receipt>; stop(): Promise<void>;
}
export class DouyinTransport implements Transport {
  constructor(options: TransportOptions); ready: boolean;
  start(listener: (event: TransportEvent) => void): Promise<void>;
  poll(): Promise<void>; send(input: SendInput): Promise<Receipt>; stop(): Promise<void>;
}
export interface StateRecord {
  platform: Platform; storeId: string; inboundMessageId: string; buyerId: string;
  conversationId: string; receivedAt: number; updatedAt?: number;
  status: 'observed' | 'deciding' | 'sending' | 'accepted' | 'unknown' | 'cancelled' | 'failed' | 'no-reply';
  receipt?: Receipt; error?: string;
}
export interface StateSnapshot { version: 1; records: Record<string, StateRecord>; paused: string[] }
export interface StateAdapter {
  snapshot(): Promise<StateSnapshot>;
  transact<T>(operation: (draft: StateSnapshot) => T): Promise<T>;
}
export class MemoryState implements StateAdapter {
  constructor(initial?: StateSnapshot); snapshot(): Promise<StateSnapshot>;
  transact<T>(operation: (draft: StateSnapshot) => T): Promise<T>;
}
export class JsonFileState extends MemoryState { constructor(file: string) }
export interface ClientOptions {
  platform: Platform; storeId: string; host?: PageHost; transport?: Transport; state?: StateAdapter;
  pollMs?: number; timeoutMs?: number; pullHistory?: boolean;
  debounceMs?: number; graceMs?: number; recoverSince?: number; decisionTimeoutMs?: number;
  decide?: (context: { messages: Message[]; last: Message; signal: AbortSignal }) =>
    string | null | undefined | Promise<string | null | undefined>;
  onEvent?: (event: ClientEvent) => unknown;
}
export class StoreClient {
  constructor(options: ClientOptions);
  start(): Promise<void>; stop(): Promise<void>; flush(): Promise<void>;
  setAutoReply(enabled: boolean): Promise<void>;
  pauseConversation(conversationId: string): Promise<void>;
  resumeConversation(conversationId: string): Promise<void>;
  getStatus(): { running: boolean; ready: boolean; autoReply: boolean };
}
export function createStoreClient(options: ClientOptions): StoreClient;
export interface ElectronFrame {
  processId: number; routingId: number; url: string; frames: ElectronFrame[];
  executeJavaScript(script: string): Promise<unknown>;
}
export function createElectronHost(guest: {
  mainFrame: ElectronFrame; isDestroyed(): boolean;
  debugger: {
    isAttached(): boolean; attach(version?: string): void; detach(): void;
    sendCommand(method: string, params?: unknown): Promise<unknown>;
    on(event: string, listener: (...args: any[]) => void): unknown;
    removeListener(event: string, listener: (...args: any[]) => void): unknown;
  }
}, platform: Platform): PageHost;
export function createPddGuestSendScript(input: { buyerId: string; text: string; previousMessageId?: string }): string;
export function parsePddGuestSendResult(value: unknown): {
  ok: boolean; status: number; platformMessageId?: string; method: string; code?: string; message?: string;
};
export function decodeTitanPayload(payloadData: string, opcode: number): unknown[];
export function extractPddCandidates(payload: unknown): Array<{ message: Record<string, unknown>; sequence?: number }>;
export function normalizePddCandidate(candidate: { message: Record<string, unknown>; sequence?: number }, storeId: string, receivedAt?: number): Message | undefined;
export function normalizeDouyinMessage(input: { message: unknown; buyerId?: string; conversationId?: string }, storeId: string, receivedAt?: number): Message | undefined;
export function createDouyinPollScript(options?: { pullHistory?: boolean }): string;
export function douyinSendScript(buyerId: string, text: string, receivedAt: number): string;
export const DOUYIN_DISPOSE_SCRIPT: string;
