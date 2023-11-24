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
const kHandleDrained = Symbol('handleDrained')

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, import('./types').IndexStreamEvents<Entry<T>>>}
 */
class MultiCoreIndexStream extends Readable {
  /** @type {Map<CoreIndexStream<T>, () => void>} */
  #streams = new Map()
  /** @type {Map<string, CoreIndexStream<T>>} */
  #streamsById = new Map()
  /** @type {Set<CoreIndexStream<T>>} */
  #readable = new Set()
  #pending = pDefer()
  #destroying = false
  // We cache drained state here rather than reading all streams every time
  #drained

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
    this.#drained = streams.length === 0
    this[kHandleIndexing] = this[kHandleIndexing].bind(this)
    this[kHandleDrained] = this[kHandleDrained].bind(this)
    for (const s of streams) {
      this.addStream(s)
    }
  }

  get remaining() {
    let remaining = 0
    for (const stream of this.#streams.keys()) {
      remaining += stream.remaining
    }
    return remaining
  }

  get drained() {
    return this.#drained
  }

  /**
   *
   * @param {string} streamId hex-encoded core key
   * @param {number} index index of block that has been indexed
   */
  setIndexed(streamId, index) {
    const stream = this.#streamsById.get(streamId)
    /* istanbul ignore next: this should always be true */
    if (!stream) return
    stream.setIndexed(index)
  }

  /**
   * Add a stream to be merged in with the rest
   *
   * @param {CoreIndexStream<T>} stream
   */
  addStream(stream) {
    if (this.#streams.has(stream)) return
    this.#drained = false
    // Do this so that we can remove this listener when we destroy the stream
    const handleReadableFn = this[kHandleReadable].bind(this, stream)
    this.#streams.set(stream, handleReadableFn)
    this.#streamsById.set(stream.id, stream)
    this.#readable.add(stream)
    stream.on('readable', handleReadableFn)
    stream.on('indexing', this[kHandleIndexing])
    stream.on('drained', this[kHandleDrained])
  }

  /** @param {any} cb */
  _open(cb) {
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
      stream.off('drained', this[kHandleDrained])
      stream.destroy()
      closePromises.push(once(stream, 'close'))
    }
    await Promise.all(closePromises)
  }

  async [kReadPromise]() {
    let didPush = false
    if (!this.#readable.size && !this.#destroying) {
      await (this.#pending = pDefer()).promise
    }
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
  // streams (the `drained` event should happen at the end of the chain once
  // everything is read)
  [kHandleIndexing]() {
    if (!this.#drained) return
    this.#drained = false
    this.emit('indexing')
  }

  [kHandleDrained]() {
    let drained = true
    for (const stream of this.#streams.keys()) {
      if (!stream.drained) drained = false
    }
    if (drained === this.#drained && !drained) return
    this.#drained = drained
    this.emit('drained')
  }
}

exports.MultiCoreIndexStream = MultiCoreIndexStream
