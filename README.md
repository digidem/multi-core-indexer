# multi-core-indexer

[![Node.js CI](https://github.com/digidem/multi-core-indexer/workflows/Node.js%20CI/badge.svg)](https://github.com/digidem/multi-core-indexer/actions/workflows/node.js.yml)
[![Coverage Status](https://coveralls.io/repos/github/digidem/multi-core-indexer/badge.svg)](https://coveralls.io/github/digidem/multi-core-indexer)
[![Npm package version](https://img.shields.io/npm/v/multi-core-indexer)](https://npmjs.com/package/multi-core-indexer)

**⚠️ This is an Alpha release and the API will likely change. Do not use in
production. ⚠️**

Index one or more
[hypercores](https://github.com/hypercore-protocol/hypercore-next)

You can use this module to index one or more hypercores. The `batch()` function
will be called with every downloaded entry in the hypercore(s), and will be
called as new entries are downloaded or appended. The index state is persisted,
so indexing will continue where it left off between restarts.

This module is useful if you want to create an index of items in multiple
[Hypercores](https://github.com/hypercore-protocol/hypercore-next). There is no
guarantee of ordering, so the indexer needs to be able to index unordered data.
Sparse hypercores are supported, and undownloaded entries in the hypercore will
be indexed when they are downloaded.

## Table of Contents

- [Install](#install)
- [Usage](#usage)
- [API](#api)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Install

```bash
npm install multi-core-indexer
```

## Usage

```js
const MultiCoreIndexer = require('multi-core-indexer')
const raf = require('random-access-file')
const Hypercore = require('hypercore')

function createStorage(key) {
  return raf(`./${key}`)
}

function batch(entries) {
  for (const { key, block, index } of entries) {
    console.log(`Block ${index} of core ${key.toString('hex')} is ${block})
  }
}

const cores = [
  new Hypercore('./core1'),
  new Hypercore('./core2'),
]

const indexer = new MultiCoreIndex(cores, { storage: createStorage, batch })

```

## API

### const indexer = new MultiCoreIndexer(cores, opts)

### cores

_Required_\
Type: `Array<Hypercore>`

An array of [Hypercores](https://github.com/hypercore-protocol/hypercore-next)
to index. All Hypercores must share the same value encoding (`binary`, `utf-8`
or `json`).

### opts

_Required_\
Type: `object`

#### opts.batch

_Required_\
Type: `(entries: Array<{ key: Buffer, block: Buffer | string | Json, index: number }>) => Promise<void>`

Called with an array of entries as they are read from the hypercores. The next
batch will not be called until `batch()` resolves. Entries will be queued (and
batched) as fast as they can be read, up to `opts.maxBatch`. `block` is the
block of data from the hypercore, `key` is the public key where the `block` is
from, and `index` is the index of the `block` within the hypercore.

**Note:** Currently if `batch` throws an error, things will break, and the
entries will still be persisted as indexed. This will be fixed in a later
release.

#### opts.storage

_Required_\
Type: `(key: string) => RandomAccessStorage`

A function that will be called with a hypercore public key as a hex-encoded
string, that should return a
[random-access-storage](https://github.com/random-access-storage) instance. This
is used to store the index state of each hypercore. (Index state is stored as a
bitfield).

#### opts.maxBatch

_Optional_\
Type: `number`

The max size of each batch in bytes.

#### opts.byteLength

_Optional_\
Type: `(entry: { key: Buffer, block: Buffer | string | Json, index: number }) => number`

Optional function that calculates the byte size of input data. By default, if
the value encoding of the underlying Hypercore is `binary` or `utf-8`, this will
be the byte length of all the blocks in the batch. If the value encoding is
`json` then this will be the number of entries in a batch.

### indexer.state

Type: `IndexState: { current: 'idle' | 'indexing', remaining: number, entriesPerSecond: number }`

A getter that returns the current `IndexState`, the same as the value emitted by the `index-state` event. This getter is useful for checking the state of the indexer before it has emitted any events.

### indexer.addCore(core)

#### core

_Required_\
Type: `Hypercore`

Add a hypercore to the indexer. Must have the same value encoding as other
hypercores already in the indexer.

### indexer.close()

Stop the indexer and flush index state to storage. This will not close the
underlying storage - it is up to the consumer to do that.

### indexer.on('index-state', onState)

#### onState

_Required_\
Type: `(indexState: { current: 'idle' | 'indexing', remaining: number, entriesPerSecond: number }) => void`

Event listener for the current indexing state. `entriesPerSecond` is the current
average number of entries being processed per second. This is calculated as a
moving average with a decay factor of 5. `remaining` is the number of entries
remaining to index. To estimate time remaining in seconds, use
`remaining / entriesPerSecond`.

### indexer.on('indexing', handler)

#### handler

_Required_\
Type: `() => void`

Event listener for when the indexer re-starts indexing (e.g. when unindexed
blocks become available, either through an append or a download).

### indexer.on('idle', handler)

#### handler

_Required_\
Type: `() => void`

Event listener for when the indexer has completed indexing of available data.
**Note**: During sync this can be emitted before sync is complete because the
indexer has caught up with currently downloaded data, and the indexer will start
indexing again as new data is downloaded.

## Maintainers

[@digidem](https://github.com/digidem)

## Contributing

PRs accepted.

Small note: If editing the README, please conform to the
[standard-readme](https://github.com/RichardLitt/standard-readme) specification.

## License

MIT © 2022 Digital Democracy
