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

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {Readable<Entry<T>, Entry<T>, Entry<T>, true, false, import('./types').IndexStreamEvents<Entry<T>>>}
 */
class MultiCoreIndexStream extends Readable {
  #handleIndexingBound
  #handleDrainedBound
  /** @type {Map<CoreIndexStream<T>, () => void>} */
  #streams = new Map()
  /** @type {Map<string, CoreIndexStream<T>>} */
  #streamsById = new Map()
  /** @type {Set<CoreIndexStream<T>>} */
  #readable = new Set()
  #pending = pDefer()
  #destroying = false

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
    this.#handleIndexingBound = this.#handleIndexing.bind(this)
    this.#handleDrainedBound = this.#handleDrained.bind(this)
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
    for (const stream of this.#streams.keys()) {
      if (!stream.drained) return false
    }
    return true
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
    // Do this so that we can remove this listener when we destroy the stream
    const handleReadableFn = this.#handleReadable.bind(this, stream)
    this.#streams.set(stream, handleReadableFn)
    stream.core
      .ready()
      .then(() => {
        // This can happen if the stream was removed between the call to `.ready()` and the time it resolved.
        if (!this.#streams.has(stream)) return
        const coreKey = stream.core.key
        /* istanbul ignore next: this is set after ready */
        if (!coreKey) return
        this.#streamsById.set(coreKey.toString('hex'), stream)
      })
      .catch(noop)
    this.#readable.add(stream)
    stream.on('readable', handleReadableFn)
    stream.on('indexing', this.#handleIndexingBound)
    stream.on('drained', this.#handleDrainedBound)
  }

  /**
   * Remove a stream and unlink its storage. If the stream is not found, this is a no-op.
   *
   * @param {CoreIndexStream<T>} stream
   * @returns {Promise<void>}
   */
  async removeStreamAndUnlinkStorage(stream) {
    const handleReadableFn = this.#streams.get(stream)
    if (!handleReadableFn) return

    const wasDrained = this.drained
    await this.#removeStream(stream, handleReadableFn)
    await stream.unlinkStorage()
    if (!wasDrained && this.drained) this.emit('drained')
  }

  /**
   * @param {CoreIndexStream<T>} stream
   * @param {() => void} handleReadableFn
   * @returns {Promise<void>}
   */
  async #removeStream(stream, handleReadableFn) {
    this.#readable.delete(stream)
    this.#streams.delete(stream)
    const coreKeyString = stream.core.key?.toString('hex')
    if (coreKeyString) this.#streamsById.delete(coreKeyString)

    stream.off('readable', handleReadableFn)
    stream.off('indexing', this.#handleIndexingBound)
    stream.off('drained', this.#handleDrainedBound)

    const closePromise = once(stream, 'close')
    stream.destroy()
    await closePromise
  }

  /** @param {any} cb */
  _open(cb) {
    cb()
  }

  /** @param {any} cb */
  _read(cb) {
    this.#read().then(cb, cb)
  }

  _predestroy() {
    this.#destroying = true
    this.#pending.resolve()
  }

  /** @param {any} cb */
  _destroy(cb) {
    this.#destroy().then(cb, cb)
  }

  async #destroy() {
    const removePromises = []
    for (const [stream, handleReadableFn] of this.#streams) {
      removePromises.push(this.#removeStream(stream, handleReadableFn))
    }
    await Promise.all(removePromises)
  }

  async #read() {
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
      await this.#read()
    }
  }

  /** @param {CoreIndexStream<T>} stream */
  #handleReadable(stream) {
    this.#readable.add(stream)
    this.#pending.resolve()
  }

  #handleIndexing() {
    let indexingCount = 0
    for (const stream of this.#streams.keys()) {
      if (!stream.drained) indexingCount++
      // We only care if there's exactly 1, so we can break early as an optimization.
      if (indexingCount >= 2) break
    }
    const isFirstIndexing = indexingCount === 1

    if (isFirstIndexing) this.emit('indexing')
  }

  #handleDrained() {
    const allDrained = this.drained
    if (allDrained) this.emit('drained')
  }
}

exports.MultiCoreIndexStream = MultiCoreIndexStream

/* istanbul ignore next: TODO add test for adding broken cores */
function noop() {}
