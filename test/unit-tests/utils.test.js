// @ts-check
const test = require('node:test')
const assert = require('node:assert/strict')
const { ExhaustivenessError } = require('../../lib/utils.js')

test('ExhaustivenessError', () => {
  const bools = [true, false]
  assert.doesNotThrow(() => {
    bools.forEach((bool) => {
      switch (bool) {
        case true:
        case false:
          break
        default:
          throw new ExhaustivenessError(bool)
      }
    })
  })
})
