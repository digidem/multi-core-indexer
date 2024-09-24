const { test } = require('node:test')
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
