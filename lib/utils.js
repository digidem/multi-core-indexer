// @ts-check

/**
 * @internal
 * @template [T=void]
 * @typedef {object} DeferredPromise
 * @prop {Promise<T>} promise
 * @prop {(value: T | PromiseLike<T>) => void} resolve
 * @prop {(reason: unknown) => void} reject
 */

/**
 * @template [T=void]
 * @returns {DeferredPromise<T>}
 */
function pDefer() {
  /** @type {DeferredPromise<T>} */
  const deferred = {}
  /** @type {Promise<T>} */
  deferred.promise = new Promise((res, rej) => {
    deferred.resolve = res
    deferred.reject = rej
  })
  return deferred
}
exports.pDefer = pDefer

class ExhaustivenessError extends Error {
  /* c8 ignore next 5 */
  /** @param {never} value */
  constructor(value) {
    super(`Exhaustiveness check failed. ${value} should be impossible`)
    this.name = 'ExhaustivenessError'
  }
}
exports.ExhaustivenessError = ExhaustivenessError
