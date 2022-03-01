const Hypercore = require('hypercore')
const ram = require('random-access-memory')

const BLOCK_LENGTH = Buffer.from('block000000').byteLength

module.exports = {
  async create(...args) {
    const core = new Hypercore(ram, ...args)
    await core.ready()
    return core
  },

  replicate(a, b, t) {
    const s1 = a.replicate(true, { keepAlive: false })
    const s2 = b.replicate(false, { keepAlive: false })
    s1.on('error', (err) =>
      t.comment(`replication stream error (initiator): ${err}`)
    )
    s2.on('error', (err) =>
      t.comment(`replication stream error (responder): ${err}`)
    )
    s1.pipe(s2).pipe(s1)
    return [s1, s2]
  },

  async eventFlush() {
    await new Promise((resolve) => setImmediate(resolve))
  },
  generateFixture,
  BLOCK_LENGTH,
  throttledIdle,
}

/**
 *
 * @param {number} start
 * @param {number} end
 * @returns {Buffer[]}
 */
function generateFixture(start, end) {
  const blocks = []
  for (let i = start; i < end; i++) {
    blocks.push(
      Buffer.from(
        `block${i.toString().padStart(BLOCK_LENGTH - 'block'.length, '0')}`
      )
    )
  }
  return blocks
}

/**
 * The index stream can become momentarily idle between reads and
 * appends/downloads of new data. This throttle idle will resolve only when the
 * stream has remained idle for > 200ms
 * @param {CoreIndexStream} emitter
 * @returns {Promise<void>}
 */
async function throttledIdle(emitter) {
  return new Promise((resolve) => {
    /** @type {ReturnType<setTimeout>} */
    let timeoutId
    emitter.on('idle', function onIdle() {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        emitter.off('idle', onIdle)
        emitter.off('indexing', onIndexing)
        resolve()
      }, 200)
    })
    emitter.on('indexing', onIndexing)
    function onIndexing() {
      clearTimeout(timeoutId)
    }
  })
}
