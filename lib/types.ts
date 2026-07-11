import { ReadableEvents } from 'streamx'

export type IndexStateCurrent = 'idle' | 'indexing' | 'closing' | 'closed'

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
}

export type IndexStreamEvents<T> = ReadableEvents<T> & {
  drained: () => void
  indexing: () => void
}

export type ValueEncoding = 'binary' | 'utf-8' | 'json'

export interface Entry<T extends ValueEncoding = 'binary'> {
  index: number
  discoveryId: string
  block: T extends 'binary' ? Buffer : T extends 'utf-8' ? string : JSONValue
}

export type JSONValue =
  | null
  | string
  | number
  | boolean
  | { [x: string]: JSONValue }
  | Array<JSONValue>
