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

function formatKey(key) {
  return key.toString('hex').slice(0, 7)
}

exports.formatKey = formatKey

/**
 * @param {string | Buffer | JSONValue} data
 * @returns {data is ArrayBufferLike}
 */
function isTypedArray(data) {
  return (
    typeof data === 'object' &&
    data !== null &&
    // @ts-ignore
    typeof data.byteLength === 'number'
  )
}

/**
 * @template {ValueEncoding} T
 * @param {Entry<T>} data
 * @returns {number}
 */
function defaultByteLength(data) {
  return isTypedArray(data.block)
    ? data.block.byteLength
    : typeof data.block === 'string'
    ? data.block.length
    : 1024
}

exports.defaultByteLength = defaultByteLength
