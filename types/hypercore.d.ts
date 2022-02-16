declare module 'hypercore' {
  import { TypedEmitter } from 'tiny-typed-emitter'

  interface HypercoreEvents {
    'peer-add'(peer: any): void
    'peer-remove'(peer: any): void
    download(index: number, byteLength: number, from: any): void
    ready(): void
    close(allClosed: boolean): void
    upload(index: number, byteLength: number, to: any): void
    truncate(index: number, fork: number): void
    append(): void
  }

  class Hypercore extends TypedEmitter<HypercoreEvents> {
    [key: string]: any
  }

  export = Hypercore
}
