import { ReadableEvents } from 'streamx'

export type IndexStateCurrent = 'idle' | 'indexing' | 'closing' | 'closed'

export interface IndexStreamEvents extends ReadableEvents {
  drained: []
  indexing: []
  /**
   * Emitted synchronously when the stream (or, for MultiCoreIndexStream, any
   * of its source streams) starts destroying. Unlike 'error' and 'close',
   * which only fire after teardown completes, this fires the moment
   * destruction is initiated.
   */
  destroying: []
}

export interface IndexState {
  current: IndexStateCurrent
  remaining: number
  entriesPerSecond: number
}

export interface IndexStreamState {
  remaining: number
  drained: boolean
}

export interface IndexEvents {
  'index-state': (state: IndexState) => void
  indexing: () => void
  idle: () => void
  error: (err: Error) => void
}

export type ValueEncoding = 'binary' | 'utf-8' | 'json'

export interface Entry<T extends ValueEncoding = 'binary'> {
  index: number
  key: Buffer
  block: T extends 'binary' ? Buffer : T extends 'utf-8' ? string : JSONValue
}

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | { [x: string]: JSONValue }
  | Array<JSONValue>
