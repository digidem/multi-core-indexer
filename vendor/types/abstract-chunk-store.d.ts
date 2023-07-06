declare module 'abstract-chunk-store' {
  class ChunkStore {
    constructor(chunkLength: number)
    put(
      index: number,
      chunkBuffer: Buffer,
      cb?: (err: Error | null) => void
    ): void
    get(
      index: number,
      cb: (err: Error | null, chunkBuffer: Buffer) => void
    ): void
    get(
      index: number,
      options: { offset: number; length: number },
      cb: (err: Error | null, chunkBuffer: Buffer) => void
    ): void
    close(cb?: (err: Error | null) => void): void
    destroy(cb?: (err: Error | null) => void): void
    chunkLength: number
  }
  export = ChunkStore
}
