declare module 'nanobench' {
  interface Bench {
    start(): void
    end(): void
  }
  function nanobench(name: string, fn: (b: Bench) => void): void
  export = nanobench
}
