const test = require('node:test')
const assert = require('node:assert/strict')
const ram = require('random-access-memory')
const Bitfield = require('../../lib/bitfield')

test('bitfield - set and get', async function () {
  const b = await Bitfield.open(new ram())

  assert.equal(b.get(42), false)
  b.set(42, true)
  assert.ok(b.get(42))

  // bigger offsets
  assert.equal(b.get(42000000), false)
  b.set(42000000, true)
  assert.ok(b.get(42000000))

  b.set(42000000, false)
  assert.equal(b.get(42000000), false)

  await b.flush()
})

test('bitfield - set and get, no storage', async function () {
  const b = await new Bitfield()

  assert.equal(b.get(42), false)
  b.set(42, true)
  assert.ok(b.get(42))

  // bigger offsets
  assert.equal(b.get(42000000), false)
  b.set(42000000, true)
  assert.ok(b.get(42000000))

  b.set(42000000, false)
  assert.equal(b.get(42000000), false)

  await b.flush()
})

test('bitfield - random set and gets', async function () {
  const b = await Bitfield.open(new ram())
  const set = new Set()

  for (let i = 0; i < 200; i++) {
    const idx = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    b.set(idx, true)
    set.add(idx)
  }

  for (let i = 0; i < 500; i++) {
    const idx = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
    const expected = set.has(idx)
    const val = b.get(idx)
    if (val !== expected) {
      assert.fail('expected ' + expected + ' but got ' + val + ' at ' + idx)
      return
    }
  }

  for (const idx of set) {
    const val = b.get(idx)
    if (val !== true) {
      assert.fail('expected true but got ' + val + ' at ' + idx)
      return
    }
  }
})

test('bitfield - reload', async function () {
  const s = new ram()

  {
    const b = await Bitfield.open(s)
    b.set(142, true)
    b.set(40000, true)
    b.set(1424242424, true)
    await b.flush()
  }

  {
    const b = await Bitfield.open(s)
    assert.ok(b.get(142))
    assert.ok(b.get(40000))
    assert.ok(b.get(1424242424))
  }
})

// Regression test: bits set while a flush's writes are in flight used to be
// dropped from the unflushed queue when the flush completed, so they were
// never persisted by any later flush
test('bitfield - bits set during in-flight flush are persisted', async function () {
  const createRAM = ram.reusable()
  const storage = makeSlowWriteStorage(createRAM('bitfield'))

  const b = await Bitfield.open(storage)
  b.set(10, true)
  storage.slowWrites = true
  const flushPromise = b.flush()
  // These are set while the writes for the first flush are still in flight
  b.set(20, true)
  b.set(40000, true)
  await flushPromise
  storage.slowWrites = false
  await b.flush()
  await b.close()

  const reloaded = await Bitfield.open(createRAM('bitfield'))
  assert.ok(reloaded.get(10), 'bit set before flush is persisted')
  assert.ok(reloaded.get(20), 'bit set during in-flight flush is persisted')
  assert.ok(
    reloaded.get(40000),
    'bit on another page set during in-flight flush is persisted'
  )
})

test('bitfield - failed flush is retried by the next flush', async function () {
  const createRAM = ram.reusable()
  const storage = makeSlowWriteStorage(createRAM('bitfield'))

  const b = await Bitfield.open(storage)
  b.set(10, true)
  b.set(40000, true)
  storage.failWrites = true
  await assert.rejects(() => b.flush(), /write failed/)
  storage.failWrites = false
  await b.flush()
  await b.close()

  const reloaded = await Bitfield.open(createRAM('bitfield'))
  assert.ok(reloaded.get(10), 'bit is persisted by the retried flush')
  assert.ok(reloaded.get(40000), 'bit on another page is persisted too')
})

/**
 * Patch a storage so that writes can be slowed by a couple of ticks (to
 * interleave set() calls with an in-flight flush) or failed (to test flush
 * error handling)
 *
 * @param {InstanceType<typeof ram>} storage
 */
function makeSlowWriteStorage(storage) {
  const originalWrite = storage._write.bind(storage)
  const patched = Object.assign(storage, {
    slowWrites: false,
    failWrites: false,
    /** @param {any} req */
    _write(req) {
      if (patched.failWrites) {
        process.nextTick(() => req.callback(new Error('write failed')))
        return
      }
      if (patched.slowWrites) {
        setImmediate(() => setImmediate(() => originalWrite(req)))
        return
      }
      originalWrite(req)
    },
  })
  return patched
}
