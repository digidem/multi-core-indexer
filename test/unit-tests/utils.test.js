// @ts-check
import test from 'node:test'
import assert from 'node:assert/strict'
import { ExhaustivenessError } from '../../lib/utils.js'

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
