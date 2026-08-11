// @ts-check
import { Writable } from 'streamx'
import { TypedEmitter } from 'tiny-typed-emitter'
import raf from 'random-access-file'
import { CoreIndexStream } from './lib/core-index-stream.js'
import { MultiCoreIndexStream } from './lib/multi-core-index-stream.js'
import { pDefer, ExhaustivenessError } from './lib/utils.js'
import { BatchError, IndexerClosed, IndexerNotClosed } from './lib/errors.js'

const DEFAULT_BATCH_SIZE = 100
// The indexing rate (in entries per second) is calculated as an exponential
// moving average. A factor > 1 will put more weight on previous values.
const MOVING_AVG_FACTOR = 5

/** @typedef {string | ((name: string) => import('random-access-storage'))} StorageParam */
/** @typedef {import('./lib/types.js').ValueEncoding} ValueEncoding */
/** @typedef {import('./lib/types.js').IndexState} IndexState */
/** @typedef {import('./lib/types.js').IndexEvents} IndexEvents */
/**
 * @template {ValueEncoding} [T='binary']
 * @typedef {import('./lib/types.js').Entry<T>} Entry
 */

/**
 * @template {ValueEncoding} [T='binary']
 * @extends {TypedEmitter<IndexEvents>}
 */
export default class MultiCoreIndexer extends TypedEmitter {
  #indexStream
  #writeStream
  #batch
  /** @type {import('./lib/types.js').IndexStateCurrent} */
  #state = 'indexing'
  #rateMeasurementStart = Date.now()
  #rate = 0
  #createStorage
  #reindex
  /** @type {IndexState | undefined} */
  #prevEmittedState
  #emitStateBound
  /** @type {import('./lib/utils.js').DeferredPromise | undefined} */
  #pendingIdle
  /** @type {Promise<void>} */
  #streamsClosed
  /** @type {Promise<void> | undefined} */
  #closePromise
  #pipelineDyingBeforeClose = false

  /**
   *
   * @param {import('hypercore')<T, any>[]} cores
   * @param {object} opts
   * @param {(entries: Entry<T>[]) => Promise<void>} opts.batch Called with
   * entries to be indexed. Delivery is at-least-once: entries that were in an
   * unfinished batch during an unclean close or error are delivered again on
   * the next start, so this function must be idempotent.
   * @param {StorageParam} opts.storage
   * @param {boolean} [opts.reindex]
   * @param {number} [opts.maxBatch=100]
   */
  constructor(
    cores,
    { batch, maxBatch = DEFAULT_BATCH_SIZE, storage, reindex = false },
  ) {
    super()
    this.#createStorage = MultiCoreIndexer.defaultStorage(storage)
    this.#reindex = reindex
    const coreIndexStreams = cores.map((core) => {
      return new CoreIndexStream(core, this.#createStorage, reindex)
    })
    this.#indexStream = new MultiCoreIndexStream(coreIndexStreams, {
      highWaterMark: maxBatch,
    })
    this.#batch = batch
    this.#writeStream = new Writable({
      writev: (entries, cb) => {
        this.#handleEntries(/** @type {Entry<T>[]} */ (entries)).then(
          () => cb(null),
          cb,
        )
      },
      highWaterMark: maxBatch,
      byteLength: () => 1,
      predestroy: () => this.#handlePipelineDying(),
    })
    // The pipe callback fires exactly once, after both streams have closed:
    // with null after a clean teardown (destroyed by close()), or with the
    // root-cause error if anything failed (e.g. a core fails to read, or the
    // batch function rejects via writev).
    this.#streamsClosed = new Promise((resolve) => {
      this.#indexStream.pipe(this.#writeStream, (err) => {
        resolve()
        if (err) this.#handleError(err)
      })
    })
    // 'destroying' fires synchronously the moment the index stream or any of
    // its source streams starts destroying - 'error' and the pipe callback
    // only fire after teardown completes
    this.#indexStream.on('destroying', () => this.#handlePipelineDying())
    this.#emitStateBound = this.#emitState.bind(this)
    // This is needed because the source streams can start indexing before this
    // stream starts reading data. This ensures that the indexing state is
    // emitted when the source cores first append / download data
    this.#indexStream.on('indexing', this.#emitStateBound)
    // This is needed for source streams that start empty, so that we know that
    // the initial state of indexing has changed to idle
    this.#indexStream.on('drained', this.#emitStateBound)
  }

  /**
   * @type {IndexState}
   */
  get state() {
    return this.#getState()
  }

  /**
   * Add a hypercore to the indexer. Must have the same value encoding as other
   * hypercores already in the indexer.
   *
   * Throws if called after the indexer is closed.
   *
   * @param {import('hypercore')<T, any>} core
   */
  addCore(core) {
    this.#assertUsable('add core')
    const coreIndexStream = new CoreIndexStream(
      core,
      this.#createStorage,
      this.#reindex,
    )
    this.#indexStream.addStream(coreIndexStream)
  }

  /**
   * Resolves when indexing state is 'idle'.
   *
   * Resolves if the indexer is cleanly closed before this resolves. Rejects
   * with the pipeline error if the indexer errors first, and rejects if
   * called after the indexer is closed.
   */
  async idle() {
    this.#assertUsable('await idle')
    if (this.#getState().current === 'idle') return
    if (!this.#pendingIdle) {
      this.#pendingIdle = pDefer()
    }
    return this.#pendingIdle.promise
  }

  /**
   * Stop the indexer and flush index state to storage. This will not close the
   * underlying storage - it is up to the consumer to do that.
   *
   * No-op if called more than once: returns the same promise as the first call.
   *
   * @returns {Promise<void>}
   */
  close() {
    this.#closePromise ??= this.#close()
    return this.#closePromise
  }

  async #close() {
    this.#state = 'closing'
    this.#indexStream.off('indexing', this.#emitStateBound)
    this.#indexStream.off('drained', this.#emitStateBound)
    this.#writeStream.destroy()
    this.#indexStream.destroy()
    await this.#streamsClosed
    this.#pendingIdle?.resolve()
    this.#pendingIdle = undefined
    this.#state = 'closed'
  }

  /**
   * Called when the stream pipeline is destroyed by an error: from the batch
   * function rejecting, or from a failure reading a core (e.g. a core closed
   * while indexing). Emits 'error', rejects any pending idle() promises, and
   * closes the indexer.
   *
   * @param {Error} err
   */
  #handleError(err) {
    // Should be unreachable: an error only reaches the pipe callback if a
    // stream was destroyed with it before close() destroyed the streams
    // (streamx ignores destroy(err) once destruction has started), and any
    // such destroy sets #pipelineDyingBeforeClose via predestroy. Kept as a
    // safety net: if a future streamx let an error race a deliberate close(),
    // emitting it would risk an uncaught exception in consumers that removed
    // listeners after calling close(), and the at-least-once batch contract
    // makes a swallowed error recoverable on next start.
    /* c8 ignore next */
    if (this.#closeStarted() && !this.#pipelineDyingBeforeClose) return
    const pendingIdle = this.#pendingIdle
    this.#pendingIdle = undefined
    this.close().catch(noop)
    pendingIdle?.reject(err)
    // Emit asynchronously: this runs inside streamx's destroy dispatch, and a
    // throw from a consumer's 'error' listener there would break teardown.
    queueMicrotask(() => this.emit('error', err))
  }

  /**
   * Unlink all index files.
   *
   * This should only be called after `close()` has resolved, and rejects if not.
   */
  async unlink() {
    switch (this.#state) {
      case 'idle':
      case 'indexing':
      case 'closing':
        throw new IndexerNotClosed()
      case 'closed':
        return this.#indexStream.unlink()
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(this.#state)
    }
  }

  /**
   * Whether close() has been called, by the consumer or from #handleError.
   * Deliberately blind to pipeline death that close() has not reacted to yet:
   * that distinction is what #handleError's swallow-or-emit decision needs.
   *
   * @returns {boolean}
   */
  #closeStarted() {
    switch (this.#state) {
      case 'idle':
      case 'indexing':
        return false
      case 'closing':
      case 'closed':
        return true
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(this.#state)
    }
  }

  /**
   * Throws unless the indexer is still usable: close() not started and the
   * pipeline not dying from an error that has not yet reached #handleError.
   *
   * @param {string} action for the error message, e.g. 'add core'
   */
  #assertUsable(action) {
    if (this.#closeStarted() || this.#pipelineDyingBeforeClose) {
      throw new IndexerClosed({ action })
    }
  }

  /**
   * Called synchronously (via the streams' predestroy hooks) the moment
   * anything in the pipeline starts destroying. Ignores the destroys issued
   * by #close itself, so #pipelineDying is only ever set by pipeline death
   * that no close() had reacted to - which is exactly what #handleError's
   * swallow-or-emit decision and #assertUsable need to know.
   */
  #handlePipelineDying() {
    if (this.#closeStarted()) return
    this.#pipelineDyingBeforeClose = true
  }

  /** @param {Entry<T>[]} entries */
  async #handleEntries(entries) {
    this.#emitState()
    /* c8 ignore next - not sure this is necessary, but better safe than sorry */
    if (!entries.length) return
    try {
      await this.#batch(entries)
    } catch (err) {
      throw new BatchError({ cause: err })
    }
    for (const { key, index } of entries) {
      this.#indexStream.setIndexed(key.toString('hex'), index)
    }
    const batchTime = Date.now() - this.#rateMeasurementStart
    // Current rate entries per second
    const rate = entries.length / (batchTime / 1000)
    // Moving average rate - use current rate if this is the first measurement
    this.#rate =
      rate + (this.#rate > 0 ? (this.#rate - rate) / MOVING_AVG_FACTOR : 0)
    // Set this at the end of batch rather than start so the timing also
    // includes the reads from the index streams
    this.#rateMeasurementStart = Date.now()
    this.#emitState()
  }

  #emitState() {
    const state = this.#getState()
    switch (state.current) {
      case 'idle':
      case 'indexing':
        if (state.current !== this.#prevEmittedState?.current) {
          this.emit(state.current)
        }
        // Only emit if remaining has changed (which infers that state.current has changed)
        if (state.remaining !== this.#prevEmittedState?.remaining) {
          this.emit('index-state', state)
        }
        this.#prevEmittedState = state
        break
      /* c8 ignore next 3 */
      case 'closing':
      case 'closed':
        break
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(state.current)
    }
  }

  /** @returns {IndexState} */
  #getState() {
    const remaining = this.#indexStream.remaining
    const drained = this.#indexStream.drained
    const prevState = this.#state

    switch (this.#state) {
      case 'idle':
      case 'indexing': {
        this.#state = remaining === 0 && drained ? 'idle' : 'indexing'
        if (this.#state === 'idle' && this.#pendingIdle) {
          this.#pendingIdle.resolve()
          this.#pendingIdle = undefined
        }
        if (this.#state === 'indexing' && prevState === 'idle') {
          this.#rateMeasurementStart = Date.now()
        }
        break
      }
      case 'closing':
      case 'closed':
        break
      /* c8 ignore next 2 */
      default:
        throw new ExhaustivenessError(this.#state)
    }

    return {
      current: this.#state,
      remaining,
      entriesPerSecond: this.#rate,
    }
  }

  /**
   *
   * @param {StorageParam} storage
   * @returns {(name: string) => import('random-access-storage')}
   */
  static defaultStorage(storage) {
    if (typeof storage !== 'string') return storage
    const directory = storage
    return function createFile(name) {
      return new raf(name, { directory })
    }
  }
}

/* c8 ignore next: only called if close() rejects, which it never should */
function noop() {}
