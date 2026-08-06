// @ts-check
import { Readable } from 'streamx'
import { promisify } from 'node:util'
import Bitfield from './bitfield.js'
import { pDefer } from './utils.js'
import { HypercoreError, StorageError } from './errors.js'

/** @typedef {import('./types.js').ValueEncoding} ValueEncoding */
/** @typedef {import('./types.js').JSONValue} JSONValue */

// How many blocks to read from the core concurrently. Note that these reads are
// not coalesced: `core.get()` issues its own single-key read of the core's
// storage, so N concurrent gets are still N reads. Requesting in parallel means
// that async calls overlap, resulting in increased performance overall.
//
// 32 is a compromise between two opposing pressures: larger blocks want larger
// batches (more bytes in flight per unit of latency), while more cores want
// smaller ones, because each core's stream reads independently and total
// in-flight reads are `cores * READ_BATCH_SIZE`. Indexing throughput in
// blocks/s, 100,000 blocks, Apple M2 Pro (higher is better):
//
//              |  batch 8 |  batch 32 |  batch 64
//   ---------- | -------- | --------- | ---------
//   64B,   1   |  169,300 |   159,400 |   157,400
//   64B, 100   |  148,000 |   135,500 |   122,300
//   1KB,   1   |  154,200 |   181,300 |   197,900
//   1KB, 100   |  125,300 |   128,400 |   126,500
//   8KB,   1   |  101,700 |   161,800 |   153,600
//   8KB, 100   |  135,300 |   132,600 |   109,300
//
// Against the best result in each row, 32 is never worse than 92%, vs. 81% for
// 64 and 63% for 8. Any value in 16-64 is reasonable; below 8 throughput falls
// off sharply (reading one-at-a-time is roughly half the speed of batch 32).
const READ_BATCH_SIZE = 32
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./types.js').Entry<T>} Entry
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
 * @extends {Readable<import('./types.js').IndexStreamEvents>}
 */
export class CoreIndexStream extends Readable {
  #handleAppendBound
  #handleDownloadBound
  #handleCoreCloseBound
  /** @type {Bitfield | undefined} */
  #indexedBitfield
  /** @type {Bitfield | undefined} */
  #inProgressBitfield
  #inProgress = 0
  #core
  /** @type {import('random-access-storage') | undefined} */
  #storage
  #createStorage
  #index = 0
  /** @type {Set<number>} */
  #downloaded = new Set()
  #pending = pDefer()
  #readBufferAvailable = true
  #destroying = false
  #drained = false
  #coreClosed = false

  /**
   * @param {import('hypercore')<T, any>} core
   * @param {(name: string) => import('random-access-storage')} createStorage
   * @param {boolean} reindex
   */
  constructor(core, createStorage, reindex) {
    super({
      // Treat as object stream, count each object as size `1` so that the
      // `remaining` property can use the stream buffer to calculate how many
      // items are left to index
      highWaterMark: 16,
      byteLength: () => 1,
    })
    this.#core = core
    this.#handleAppendBound = this.#handleAppend.bind(this)
    this.#handleDownloadBound = this.#handleDownload.bind(this)
    this.#handleCoreCloseBound = this.#handleCoreClose.bind(this)
    this.#createStorage = async () => {
      await this.#core.ready()

      const { discoveryKey } = this.#core
      /* c8 ignore next: just to keep TS happy - after core.ready() this is set */
      if (!discoveryKey) throw new Error('Missing discovery key')
      const storageName = getStorageName(discoveryKey)

      if (reindex) await unlinkStorage(createStorage(storageName))

      return createStorage(storageName)
    }
  }

  get remaining() {
    // After the core is closed its length is reported as 0, so only blocks
    // already read but not yet indexed count as remaining
    if (this.#coreClosed) return this.#inProgress
    return (
      // core.close() drops core.length to 0 synchronously, before the async
      // 'close' handler sets #coreClosed, so this difference must be clamped
      // or `remaining` would go negative in that window
      Math.max(0, this.#core.length - this.#index) +
      this.#downloaded.size +
      this.#inProgress
    )
  }

  get drained() {
    return this.#drained
  }

  get core() {
    return this.#core
  }

  /** @param {any} cb */
  _open(cb) {
    this.#open().then(cb, cb)
  }

  /** @param {any} cb */
  _read(cb) {
    this.#read().then(cb, cb)
  }

  _predestroy() {
    this.#destroying = true
    this.#pending.resolve()
    this.emit('destroying')
  }

  /** @param {any} cb */
  _destroy(cb) {
    this.#destroy().then(cb, cb)
  }

  /**
   * Set a block as indexed, removes it from "inProgress"
   *
   * @param {number} index
   */
  setIndexed(index) {
    this.#inProgress--
    this.#indexedBitfield?.set(index, true)
    this.#inProgressBitfield?.set(index, false)
  }

  async unlink() {
    try {
      this.#storage ??= await this.#createStorage()
      await unlinkStorage(this.#storage)
    } catch (err) {
      throw new StorageError({ cause: err })
    }
  }

  async #destroy() {
    this.#core.removeListener('append', this.#handleAppendBound)
    this.#core.removeListener('download', this.#handleDownloadBound)
    this.#core.removeListener('close', this.#handleCoreCloseBound)
    try {
      await this.#indexedBitfield?.flush()
      if (this.#storage) await closeStorage(this.#storage)
    } catch (err) {
      throw new StorageError({ cause: err })
    }
  }

  async #open() {
    try {
      await this.#core.ready()
      await this.#core.update({ wait: true })
    } catch (err) {
      throw new HypercoreError({ cause: err })
    }
    try {
      this.#storage ??= await this.#createStorage()
      this.#indexedBitfield = await Bitfield.open(this.#storage)
    } catch (err) {
      throw new StorageError({ cause: err })
    }
    this.#inProgressBitfield = await new Bitfield()
    this.#core.on('append', this.#handleAppendBound)
    this.#core.on('download', this.#handleDownloadBound)
    // If the core is closed while this stream is still indexing it, there is
    // nothing more that can be indexed: without this the stream would wait
    // forever (a closed core reports length 0) with `remaining` inaccurate.
    // Any unindexed blocks are picked up by a future indexer from the index
    // state persisted in the bitfield, once the core is re-opened.
    this.#core.once('close', this.#handleCoreCloseBound)
  }

  async #read() {
    if (this.#index >= this.#core.length && this.#downloaded.size === 0) {
      this.#drained = true
      this.emit('drained')
      // If nothing is left to index, wait for new data
      await (this.#pending = pDefer()).promise
    }
    // A closed core has nothing more that can be indexed ('drained' was
    // already emitted above, since a closed core reports length 0): keep
    // waiting (only destroying the stream ends this) rather than emitting a
    // spurious 'indexing' event below
    while (this.#coreClosed && !this.#destroying) {
      await (this.#pending = pDefer()).promise
    }
    if (this.#coreClosed) return
    this.#drained = false
    this.emit('indexing')
    let didPush = false
    this.#readBufferAvailable = true
    while (this.#readBufferAvailable && this.#index < this.#core.length) {
      // Collect a batch of unprocessed indexes to read concurrently. Awaiting
      // each block in turn is the main indexing bottleneck: every read is a
      // round-trip to the core's storage, so in series the whole index waits
      // out that latency once per block.
      /** @type {number[]} */
      const indexes = []
      while (
        indexes.length < READ_BATCH_SIZE &&
        this.#index < this.#core.length
      ) {
        // Increment before the (async) push: newer streamx emits 'data'
        // synchronously from push(), and `remaining` must not count a pushed
        // entry via both `#index` and `#inProgress` when listeners run
        const index = this.#index++
        const isProcessed =
          this.#indexedBitfield?.get(index) ||
          this.#inProgressBitfield?.get(index)
        if (!isProcessed) indexes.push(index)
      }
      didPush = (await this.#pushEntries(indexes)) || didPush
    }
    // Still space in the read buffer? Process any downloaded blocks
    while (this.#readBufferAvailable && this.#downloaded.size > 0) {
      /** @type {number[]} */
      const indexes = []
      for (const index of this.#downloaded) {
        this.#downloaded.delete(index)
        const isProcessed =
          this.#indexedBitfield?.get(index) ||
          this.#inProgressBitfield?.get(index)
        if (!isProcessed) indexes.push(index)
        if (indexes.length >= READ_BATCH_SIZE) break
      }
      didPush = (await this.#pushEntries(indexes)) || didPush
    }
    if (!didPush && !this.#destroying) {
      // If nothing was pushed, queue up another read
      await this.#read()
    }
    try {
      await this.#indexedBitfield?.flush()
    } catch (err) {
      throw new StorageError({ cause: err })
    }
  }

  /**
   * Read the given indexes concurrently and push their entries (in order) to
   * the read buffer. Returns true if at least one entry was pushed, false if
   * all were skipped.
   *
   * @param {number[]} indexes
   * @returns {Promise<boolean>}
   */
  async #pushEntries(indexes) {
    if (indexes.length === 0) return false
    // Count these blocks as in-progress before the async reads, so that
    // `remaining` stays accurate while the reads are in flight
    this.#inProgress += indexes.length
    /** @type {Array<Entry<T>['block'] | null>} */
    let blocks
    try {
      blocks = await Promise.all(
        indexes.map((index) => this.#core.get(index, { wait: false })),
      )
    } catch (err) {
      // Reads rejected because the core was closed while they were in
      // flight: skip these blocks, like other blocks of a closed core.
      // The intersection type adds `closing`/`closed`, which exist on
      // hypercore 11 but are missing from the vendored hypercore types.
      const core =
        /** @type {import('hypercore')<T, any> & { closing?: Promise<void> | null, closed?: boolean }} */ (
          this.#core
        )
      if (core.closing || core.closed) {
        this.#inProgress -= indexes.length
        return false
      }
      throw new HypercoreError({ cause: err })
    }
    /* c8 ignore next: this should always be set at this point */
    if (!this.#core.key) throw new Error('Missing core key')
    let didPush = false
    for (let i = 0; i < indexes.length; i++) {
      const block = blocks[i]
      if (block === null) {
        this.#inProgress--
        continue
      }
      const index = indexes[i]
      this.#inProgressBitfield?.set(index, true)
      const entry = { key: this.#core.key, block, index }
      this.#readBufferAvailable = this.push(entry)
      didPush = true
    }
    return didPush
  }

  async #handleAppend() {
    this.#pending.resolve()
  }

  #handleCoreClose() {
    this.#coreClosed = true
    this.#downloaded.clear()
    // Wake a #read that is waiting for new data so it re-checks state
    this.#pending.resolve()
    // If the stream was already drained when the core closed, a parked #read
    // will not re-emit 'drained', but `remaining` has now changed (dropped to
    // in-progress only): re-emit so state listeners re-read it, otherwise a
    // pending idle() would never resolve
    if (this.#drained) this.emit('drained')
  }

  /**
   * @param {number} index
   */
  async #handleDownload(index) {
    this.#downloaded.add(index)
    this.#pending.resolve()
  }
}

/** @param {Buffer} discoveryKey */
function getStorageName(discoveryKey) {
  const id = discoveryKey.toString('hex')
  return [id.slice(0, 2), id.slice(2, 4), id].join('/')
}

/** @param {import('random-access-storage')} storage*/
function closeStorage(storage) {
  return promisify(storage.close.bind(storage))()
}

/** @param {import('random-access-storage')} storage */
function unlinkStorage(storage) {
  return promisify(storage.unlink.bind(storage))()
}
