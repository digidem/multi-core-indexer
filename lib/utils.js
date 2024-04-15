// @ts-check
/** @typedef {{ promise: Promise<void>, resolve: (value: void | PromiseLike<void>) => void, reject: (reason?: any) => void }} DeferredPromise */
function pDefer() {
  /** @type {DeferredPromise} */
  const deferred = {}

  /** @type {Promise<void>} */
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
