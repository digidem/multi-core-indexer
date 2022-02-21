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
