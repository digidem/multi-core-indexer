// @ts-check
const { Readable } = require('streamx')
const log = require('debug')('core-index-stream')
const { pDefer } = require('./utils')

/** @typedef {import('./core-index-stream').ValueEncoding} ValueEncoding */
/** @typedef {import('./core-index-stream').IndexStream} IndexStream */
/**
 * @template T
 * @typedef {import('./core-index-stream').Entry<T>} Entry
 */

const kReadPromise = Symbol('kReadPromise')
const kHandleReadable = Symbol('kHandleReadable')

/**
 *
 * @extends {Readable<Entry<'binary'>>}
 */
class MergeStream extends Readable {
  /** @type {Map<IndexStream, () => void>} */
  #streams
  /** @type {Set<IndexStream>} */
  #readable
  #pending = pDefer()
  /**
   *
   * @param {IndexStream[]} streams
   * @param {{ highWaterMark?: number }} [opts]
   */
  constructor(streams, opts = {}) {
    super({
      highWaterMark: opts.highWaterMark,
      byteLength: (entry) => entry.block.length,
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
   * @param {IndexStream} stream
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
    this.#pending.resolve()
  }

  /** @param {any} cb */
  _destroy(cb) {
    for (const [stream, handleReadableFn] of this.#streams) {
      stream.off('readable', handleReadableFn)
      stream.destroy()
    }
  }

  async [kReadPromise]() {
    if (!this.#readable.size) {
      await (this.#pending = pDefer())
    }
    let readBufferAvailable = true
    for (const stream of this.#readable) {
      let entry
      while ((entry = stream.read()) && readBufferAvailable) {
        readBufferAvailable = this.push(entry)
      }
      if (entry === null) this.#readable.delete(stream)
      if (!readBufferAvailable) break
    }
  }

  /** @param {IndexStream} stream */
  [kHandleReadable](stream) {
    this.#readable.add(stream)
    this.#pending.resolve()
  }
}

module.exports = MergeStream
