// @ts-check
// Credit to https://github.com/hypercore-protocol/hypercore-next/blob/4c720f3abcf61f9bbd5bda585ef5940c6c4212b1/lib/bitfield.js

const BigSparseArray = require('big-sparse-array')
const b4a = require('b4a')

/* c8 ignore start */
class FixedBitfield {
  /**
   * @param {number} index
   * @param {Uint32Array} bitfield
   */
  constructor(index, bitfield) {
    this.dirty = false
    this.index = index
    this.bitfield = bitfield
  }

  /** @param {number} index */
  get(index) {
    const j = index & 31
    const i = (index - j) / 32

    return i < this.bitfield.length && (this.bitfield[i] & (1 << j)) !== 0
  }

  /** @param {number} index
   * @param {boolean} val */
  set(index, val) {
    const j = index & 31
    const i = (index - j) / 32
    const v = this.bitfield[i]

    if (val === ((v & (1 << j)) !== 0)) return false

    const u = val ? v | (1 << j) : v ^ (1 << j)

    if (u === v) return false

    this.bitfield[i] = u
    return true
  }
}
/* c8 ignore stop */

/* c8 ignore start */
class Bitfield {
  /**
   *
   * @param {import('random-access-storage')} [storage]
   * @param {Buffer} [buf]
   */
  constructor(storage, buf) {
    this.pageSize = 32768
    /** @type {BigSparseArray<FixedBitfield>} */
    this.pages = new BigSparseArray()
    /** @type {Array<FixedBitfield> | undefined} */
    this.unflushed = storage ? [] : undefined
    this.storage = storage

    const all =
      buf && buf.byteLength >= 4
        ? new Uint32Array(
            buf.buffer,
            buf.byteOffset,
            Math.floor(buf.byteLength / 4)
          )
        : new Uint32Array(1024)

    for (let i = 0; i < all.length; i += 1024) {
      const bitfield = ensureSize(all.subarray(i, i + 1024), 1024)
      const page = new FixedBitfield(i / 1024, bitfield)
      this.pages.set(page.index, page)
    }
  }

  /**
   * @param {number} index
   */
  get(index) {
    const j = index & 32767
    const i = (index - j) / 32768
    const p = this.pages.get(i)

    return p ? p.get(j) : false
  }

  /**
   * @param {number} index
   * @param {boolean} val
   */
  set(index, val) {
    const j = index & 32767
    const i = (index - j) / 32768

    let p = this.pages.get(i)

    if (!p) {
      if (!val) return
      p = this.pages.set(i, new FixedBitfield(i, new Uint32Array(1024)))
    }

    if (!p.set(j, val) || p.dirty) return

    p.dirty = true
    this.unflushed?.push(p)
  }

  /** @returns {Promise<void>} */
  close() {
    return new Promise((resolve, reject) => {
      if (!this.storage) return resolve()
      this.storage.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  /** @returns {Promise<void>} */
  flush() {
    return new Promise((resolve, reject) => {
      if (!this.storage) return resolve()
      if (!this.unflushed?.length) return resolve()

      const self = this
      let missing = this.unflushed.length
      /** @type {Error | null} */
      let error = null

      for (const page of this.unflushed) {
        const buf = b4a.from(
          page.bitfield.buffer,
          page.bitfield.byteOffset,
          page.bitfield.byteLength
        )
        page.dirty = false
        this.storage.write(page.index * 4096, buf, done)
      }

      /** @param {Error | null} err */
      function done(err) {
        if (err) error = err
        if (--missing) return
        if (error) return reject(error)
        self.unflushed = []
        resolve()
      }
    })
  }

  /**
   * @param {import('random-access-storage')} storage
   * @returns {Promise<Bitfield>}
   */
  static open(storage) {
    return new Promise((resolve, reject) => {
      storage.stat((err, st) => {
        if (err) return resolve(new Bitfield(storage))
        const size = st.size - (st.size & 3)
        if (!size) return resolve(new Bitfield(storage))
        storage.read(0, size, (err, data) => {
          if (err) return reject(err)
          resolve(new Bitfield(storage, data))
        })
      })
    })
  }
}
/* c8 ignore stop */

module.exports = Bitfield

/**
 * @param {Uint32Array} uint32
 * @param {number} size
 */
function ensureSize(uint32, size) {
  if (uint32.length === size) return uint32
  /* c8 ignore next 3 */
  const a = new Uint32Array(1024)
  a.set(uint32, 0)
  return a
}
