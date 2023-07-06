declare module 'random-access-storage' {
  import { TypedEmitter } from 'tiny-typed-emitter'

  interface Events {
    open(): void
    close(): void
    destroy(): void
  }

  interface Callback<T = any> {
    (err: Error | null, value: T): void
  }

  class RandomAccessStorage extends TypedEmitter<Events> {
    readable: boolean
    writable: boolean
    deletable: boolean
    statable: boolean
    opened: boolean
    closed: boolean
    destroyed: boolean
    read(offset: number, size: number, callback: Callback<Buffer>): void
    write(offset: number, data: Buffer, callback?: Callback<void>): void
    del(offset: number, size: number, callback?: Callback<void>): void
    stat(callback: Callback<{ size: number }>): void
    open(callback: Callback<void>): void
    close(callback: Callback<void>): void
    destroy(callback: Callback<void>): void
  }

  export = RandomAccessStorage
}

declare module 'random-access-memory' {
  import RandomAccessStorage from 'random-access-storage'

  class RandomAccessMemory extends RandomAccessStorage {
    constructor()
  }

  export = RandomAccessMemory
}

declare module 'random-access-file' {
  import RandomAccessStorage from 'random-access-storage'

  class RandomAccessFile extends RandomAccessStorage {
    constructor(name: string, opts: { directory: string })
  }

  export = RandomAccessFile
}
