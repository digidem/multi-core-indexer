// @ts-check
const { Readable } = require('streamx')
const Bitfield = require('./bitfield')
const { pDefer } = require('./utils')

const kReadPromise = Symbol('readPromise')
const kOpenPromise = Symbol('openPromise')
const kDestroyPromise = Symbol('destroyPromise')
const kHandleAppend = Symbol('handleAppend')
const kHandleDownload = Symbol('handleDownload')
const kPushEntry = Symbol('pushEntry')
const kUpdateState = Symbol('updateState')

/** @typedef {import('./types').ValueEncoding} ValueEncoding */
/** @typedef {import('./types').JSONValue} JSONValue */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./types').Entry<T>} Entry
 */
/**
 * Create a ReadableStream for a Hypercore that will:
 *
 * 1. Only index downloaded blocks (it will not request blocks from peers)
 * 2. Remain open (e.g. live) awaiting new data
 * 3. Index any new blocks as they are downloaded
 * 4. Index any new blocks as they are appended
 * 5. Store index state and continue indexing from the previous state
 *
 * @template {ValueEncoding} [T='binary']
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, Omit<import('./types').IndexStreamEvents<Entry<T>>, 'index-state'>>}
 */
class CoreIndexStream extends Readable {
  /** @type {Bitfield} */
  #bitfield
  #core
  #storage
  #index = 0
  /** @type {import('./types').IndexStateCurrent} */
  #state = 'idle'
  /** @type {Set<number>} */
  #downloaded = new Set()
  #pending = pDefer()
  #readBufferAvailable = true
  #destroying = false

  /**
   * @param {import('hypercore')<T>} core
   * @param {import('random-access-storage')} storage
   */
  constructor(core, storage) {
    super({
      // Treat as object stream, count each object as size `1` so that the
      // `remaining` property can use the stream buffer to calculate how many
      // items are left to index
      highWaterMark: 16,
      byteLength: () => 1,
    })
    this.#core = core
    this.#storage = storage
    this[kHandleAppend] = this[kHandleAppend].bind(this)
    this[kHandleDownload] = this[kHandleDownload].bind(this)
  }

  get remaining() {
    return (
      this.#core.length -
      this.#index +
      this.#downloaded.size +
      // For an external consumer of this stream, items in the stream's buffer
      // are still "remaining" ie they will not have been read by the "consumer"
      // @ts-ignore - internal undocumented property
      this._readableState.buffered
    )
  }

  get key() {
    return this.#core.key
  }

  /** @param {any} cb */
  _open(cb) {
    this[kOpenPromise]().then(cb, cb)
  }

  /** @param {any} cb */
  _read(cb) {
    this[kReadPromise]().then(cb, cb)
  }

  _predestroy() {
    this.#destroying = true
    this.#pending.resolve()
  }

  /** @param {any} cb */
  _destroy(cb) {
    this[kDestroyPromise]().then(cb, cb)
  }

  async [kDestroyPromise]() {
    this.#core.removeListener('append', this[kHandleAppend])
    this.#core.removeListener('download', this[kHandleDownload])
    await this.#bitfield.flush()
  }

  async [kOpenPromise]() {
    this.#state = 'indexing'
    this.emit('indexing')
    this.#bitfield = await Bitfield.open(this.#storage)
    await this.#core.update()
    this.#core.on('append', this[kHandleAppend])
    this.#core.on('download', this[kHandleDownload])
  }

  async [kReadPromise]() {
    if (this.#index >= this.#core.length && this.#downloaded.size === 0) {
      this[kUpdateState]('idle')
      // If nothing is left to index, wait for new data
      await (this.#pending = pDefer())
    }
    this[kUpdateState]('indexing')
    let didPush = false
    this.#readBufferAvailable = true
    while (this.#readBufferAvailable && this.#index < this.#core.length) {
      didPush = (await this[kPushEntry](this.#index)) || didPush
      // Don't increment this until after the async push above
      this.#index++
    }
    // Still space in the read buffer? Process any downloaded blocks
    if (this.#readBufferAvailable) {
      for (const index of this.#downloaded.values()) {
        this.#downloaded.delete(index)
        didPush =
          (await this[kPushEntry](index)) ||
          /* istanbul ignore next - TODO: Test when hypercore-next supports a core.clear() method */
          didPush
        if (!this.#readBufferAvailable) break
      }
    }
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this[kReadPromise]()
    }
    await this.#bitfield.flush()
  }

  /**
   * Return true if the entry was pushed to the read buffer, false if it was skipped
   *
   * @param {number} index
   * @returns {Promise<boolean>}
   */
  async [kPushEntry](index) {
    const isIndexed = this.#bitfield.get(index)
    if (isIndexed) return false
    const block = await this.#core.get(index, { wait: false })
    if (block === null) return false
    this.#bitfield.set(index, true)
    const entry = { key: this.#core.key, block, index }
    this.#readBufferAvailable = this.push(entry)
    return true
  }

  /** @param {import('./types').IndexStateCurrent} newState*/
  [kUpdateState](newState) {
    // Only emit state changes when the state actually changes
    if (this.#state === newState) return
    // Don't emit state if the stream is being destroyed
    if (this.#destroying) return
    this.#state = newState
    this.emit(newState)
  }

  async [kHandleAppend]() {
    this.#pending.resolve()
  }

  /**
   * @param {number} index
   */
  async [kHandleDownload](index) {
    this.#downloaded.add(index)
    this.#pending.resolve()
  }
}

exports.CoreIndexStream = CoreIndexStream
