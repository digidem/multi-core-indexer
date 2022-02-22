// @ts-check
const { Readable } = require('streamx')
const log = require('debug')('merge-stream')
const { pDefer, defaultByteLength } = require('./utils')
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
const kReadPromise = Symbol('kReadPromise')
const kHandleReadable = Symbol('kHandleReadable')
const kDestroyPromise = Symbol('destroyPromise')

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

  /**
   *
   * @param {CoreIndexStream<T>[]} streams
   * @param {{ highWaterMark?: number }} [opts]
   */
  constructor(streams, opts = {}) {
    super({
      highWaterMark: opts.highWaterMark,
      byteLength: defaultByteLength,
    })
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
      stream.destroy()
      closePromises.push(once(stream, 'close'))
    }
    await Promise.all(closePromises)
  }

  async [kReadPromise]() {
    log('read', this.#readable.size)
    let didPush = false
    if (!this.#readable.size && !this.#destroying) {
      this.#timeoutId = setTimeout(() => this.emit('indexed'), 200)
      await (this.#pending = pDefer())
    }
    let readBufferAvailable = true
    for (const stream of this.#readable) {
      let entry
      while ((entry = stream.read())) {
        readBufferAvailable = this.push(entry)
        didPush = true
        log(
          'push',
          entry.index,
          stream.key.toString('hex').slice(0, 7),
          readBufferAvailable
        )
        if (!readBufferAvailable) break
      }
      if (entry === null) this.#readable.delete(stream)
      if (!readBufferAvailable) break
    }
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this[kReadPromise]()
    }
    if (didPush) this.emit('index-state', { remaining: this.remaining })
  }

  /** @param {CoreIndexStream<T>} stream */
  [kHandleReadable](stream) {
    log('readable')
    clearTimeout(this.#timeoutId)
    this.#readable.add(stream)
    this.#pending.resolve()
  }
}

exports.MultiCoreIndexStream = MultiCoreIndexStream
