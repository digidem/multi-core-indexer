// @ts-check
const { Readable } = require('streamx')
const { pDefer } = require('./utils')
const { once } = require('events')

/** @typedef {import('./types').ValueEncoding} ValueEncoding */
/** @typedef {import('./types').JSONValue} JSONValue */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./types').Entry<T>} Entry
 */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./core-index-stream').CoreIndexStream<T>} CoreIndexStream
 */
const kReadPromise = Symbol('readPromise')
const kHandleReadable = Symbol('handleReadable')
const kDestroyPromise = Symbol('destroyPromise')
const kHandleIndexing = Symbol('handleIndexing')
const kUpdateState = Symbol('updateState')

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, import('./types').IndexStreamEvents<Entry<T>>>}
 */
class MultiCoreIndexStream extends Readable {
  /** @type {Map<CoreIndexStream<T>, () => void>} */
  #streams = new Map()
  /** @type {Set<CoreIndexStream<T>>} */
  #readable = new Set()
  #pending = pDefer()
  /** @type {ReturnType<typeof setTimeout>} */
  #timeoutId
  #destroying = false
  /** @type {import('./types').IndexStateCurrent} */
  #state = 'idle'

  /**
   *
   * @param {CoreIndexStream<T>[]} streams
   * @param {{ highWaterMark?: number }} [opts]
   */
  constructor(streams, opts = {}) {
    super({
      // Treat as object stream, count each object as size `1` so that the
      // `remaining` property can use the stream buffer to calculate how many
      // items are left to index
      highWaterMark: opts.highWaterMark || 16,
      byteLength: () => 1,
    })
    this[kHandleIndexing] = this[kHandleIndexing].bind(this)
    for (const s of streams) {
      this.addStream(s)
    }
  }

  get remaining() {
    let remaining = 0
    for (const stream of this.#streams.keys()) {
      remaining += stream.remaining
    }
    return (
      remaining +
      // @ts-ignore - reading internal buffer size, which is undocumented
      this._readableState.buffered
    )
  }

  /**
   * Add a stream to be merged in with the rest
   *
   * @param {CoreIndexStream<T>} stream
   */
  addStream(stream) {
    if (this.#streams.has(stream)) return
    // Do this so that we can remove this listener when we destroy the stream
    const handleReadableFn = this[kHandleReadable].bind(this, stream)
    this.#streams.set(stream, handleReadableFn)
    this.#readable.add(stream)
    stream.on('readable', handleReadableFn)
    stream.on('indexing', this[kHandleIndexing])
  }

  /** @param {any} cb */
  _open(cb) {
    this.#state = 'indexing'
    this.emit('indexing')
    cb()
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
    const closePromises = []
    for (const [stream, handleReadableFn] of this.#streams) {
      stream.off('readable', handleReadableFn)
      stream.off('indexing', this[kHandleIndexing])
      stream.destroy()
      closePromises.push(once(stream, 'close'))
    }
    await Promise.all(closePromises)
  }

  async [kReadPromise]() {
    let didPush = false
    if (!this.#readable.size && !this.#destroying) {
      this[kUpdateState]('idle')
      await (this.#pending = pDefer())
    }
    this[kUpdateState]('indexing')
    let readBufferAvailable = true
    for (const stream of this.#readable) {
      let entry
      while ((entry = stream.read())) {
        readBufferAvailable = this.push(entry)
        didPush = true
        if (!readBufferAvailable) break
      }
      if (entry === null) this.#readable.delete(stream)
      if (!readBufferAvailable) break
    }
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this[kReadPromise]()
    }
  }

  /** @param {CoreIndexStream<T>} stream */
  [kHandleReadable](stream) {
    this.#readable.add(stream)
    this.#pending.resolve()
  }

  // Whenever a source stream emits an indexing event, bubble it up so that the
  // `indexing` event always fires at the start of indexing in the chain of
  // streams (the `idle` event should happen at the end of the chain once
  // everything is written)
  [kHandleIndexing]() {
    if (this.#state === 'indexing') return
    this.#state = 'indexing'
    this.emit('indexing')
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
}

exports.MultiCoreIndexStream = MultiCoreIndexStream
