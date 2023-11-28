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
