/** @typedef {Promise<void> & { resolve: () => void, reject: (err: Error) => void }} DeferredPromise */
function pDefer() {
  let resolve, reject
  /** @type {any} */
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  // Yuck, I'm overloading the promise with additional methods. But it makes the
  // code where it is used more concise :shrug:
  promise.resolve = resolve
  promise.reject = reject

  return /** @type {DeferredPromise} */ (promise)
}
exports.pDefer = pDefer
