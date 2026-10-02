import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const empty = () => ({ version: 1, records: {}, paused: [] })
function validate(value) {
  if (value?.version !== 1 || !value.records || Array.isArray(value.records) ||
    typeof value.records !== 'object' || !Array.isArray(value.paused)) throw new Error('STATE_INVALID')
  return value
}
export class MemoryState {
  constructor(initial) {
    this.value = initial ? structuredClone(validate(initial)) : empty()
    this.queue = Promise.resolve()
  }
  async load() { return this.value }
  async save(value) { this.value = value }
  transact(operation) {
    const work = this.queue.catch(() => {}).then(async () => {
      const draft = structuredClone(await this.load())
      const result = operation(draft)
      if (result instanceof Promise) throw new Error('STATE_TRANSACTION_MUST_BE_SYNCHRONOUS')
      const keys = Object.keys(draft.records)
      // Retention is bounded; not a permanent exactly-once ledger.
      for (const key of keys.slice(0, Math.max(0, keys.length - 10000))) delete draft.records[key]
      await this.save(validate(draft))
      return structuredClone(result)
    })
    this.queue = work
    return work
  }
  async snapshot() {
    await this.queue.catch(() => {})
    return structuredClone(await this.load())
  }
}
export class JsonFileState extends MemoryState {
  constructor(file) { super(); this.file = file }
  async load() {
    this.loading ??= (async () => {
      try { this.value = validate(JSON.parse(await readFile(this.file, 'utf8'))) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      return this.value
    })()
    await this.loading
    return this.value
  }
  async save(value) {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, this.file)
      this.value = value
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }
}
