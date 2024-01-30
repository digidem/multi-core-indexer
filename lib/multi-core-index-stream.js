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
    const handleReadableFn = this.#handleReadable.bind(this, stream)
    this.#streams.set(stream, handleReadableFn)
    stream.core
      .ready()
      .then(() => {
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
   * Unlink all index files. This should only be called after close.
   */
  async unlink() {
    /** @type {Array<Promise<unknown>>} */
    const unlinkPromises = []
    for (const stream of this.#streams.keys()) {
      unlinkPromises.push(stream.unlink())
    }
    await Promise.all(unlinkPromises)
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
    const closePromises = []
    for (const [stream, handleReadableFn] of this.#streams) {
      stream.off('readable', handleReadableFn)
      stream.off('indexing', this.#handleIndexingBound)
      stream.off('drained', this.#handleDrainedBound)
      stream.destroy()
      closePromises.push(once(stream, 'close'))
    }
    await Promise.all(closePromises)
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

  // Whenever a source stream emits an indexing event, bubble it up so that the
  // `indexing` event always fires at the start of indexing in the chain of
  // streams (the `drained` event should happen at the end of the chain once
  // everything is read)
  #handleIndexing() {
    if (!this.#drained) return
    this.#drained = false
    this.emit('indexing')
  }

  #handleDrained() {
    let drained = true
    for (const stream of this.#streams.keys()) {
      if (!stream.drained) {
        drained = false
        break
      }
    }
    if (drained === this.#drained && !drained) return
    this.#drained = drained
    this.emit('drained')
  }
}

exports.MultiCoreIndexStream = MultiCoreIndexStream

/* istanbul ignore next: TODO add test for adding broken cores */
function noop() {}
