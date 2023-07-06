declare module 'big-sparse-array' {
  class BigSparseArray<T = any> {
    set(index: number, value: T): T
    get(index: number): T | void
  }
  export = BigSparseArray
}
