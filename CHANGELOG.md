# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.0.0](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.10...v1.0.0) (2024-10-30)

### Features

- reindexing ([#45](https://github.com/digidem/multi-core-indexer/issues/45)) ([b8a7957](https://github.com/digidem/multi-core-indexer/commit/b8a7957a1b40d998d2cf7d8e706e90053b21be51))

## [1.0.0-alpha.10](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.9...v1.0.0-alpha.10) (2024-05-01)

### ⚠ BREAKING CHANGES

- drop Node 16 support (#40)
- Node 16.17.1+ is now required.

### Features

- add method to unlink storage ([#34](https://github.com/digidem/multi-core-indexer/issues/34)) ([98a0e25](https://github.com/digidem/multi-core-indexer/commit/98a0e2537fa7f77ce4e99de9298acfc805549a10)), closes [#26](https://github.com/digidem/multi-core-indexer/issues/26)
- reject if closed state is incorrect ([#42](https://github.com/digidem/multi-core-indexer/issues/42)) ([f56037a](https://github.com/digidem/multi-core-indexer/commit/f56037a752887b02a9ddb92cec5c39993dab5461))

### Bug Fixes

- docs shouldn't require ready cores ([#29](https://github.com/digidem/multi-core-indexer/issues/29)) ([7cd3aaf](https://github.com/digidem/multi-core-indexer/commit/7cd3aafa70f2894042a5ac9929eb6ad083ad4177)), closes [#24](https://github.com/digidem/multi-core-indexer/issues/24)

- develop on Node 20, CI with 16.17.1 + 18.17.1 + 20 ([#35](https://github.com/digidem/multi-core-indexer/issues/35)) ([b85c3b6](https://github.com/digidem/multi-core-indexer/commit/b85c3b6f782a23a6cbbec2ebedf663fea955d66e))
- drop Node 16 support ([#40](https://github.com/digidem/multi-core-indexer/issues/40)) ([c87f8fb](https://github.com/digidem/multi-core-indexer/commit/c87f8fbd55dca131dd45770012369c6f28cf5d4b))

## [1.0.0-alpha.9](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.8...v1.0.0-alpha.9) (2023-11-28)

### Features

- `.idle()`, initial state 'indexing', non-ready cores ([#22](https://github.com/digidem/multi-core-indexer/issues/22), [#24](https://github.com/digidem/multi-core-indexer/issues/24)) ([89ac7ae](https://github.com/digidem/multi-core-indexer/commit/89ac7ae4551b75713ca2a13c3a5e2eb741eb4519)), closes [#23](https://github.com/digidem/multi-core-indexer/issues/23)

## [1.0.0-alpha.8](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.7...v1.0.0-alpha.8) (2023-11-16)

### Bug Fixes

- close storages on close ([#20](https://github.com/digidem/multi-core-indexer/issues/20)) ([aa4d34e](https://github.com/digidem/multi-core-indexer/commit/aa4d34ecf3d8528c28b6a2a70c733eab71b01468)), closes [#19](https://github.com/digidem/multi-core-indexer/issues/19)

## [1.0.0-alpha.7](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.6...v1.0.0-alpha.7) (2023-08-30)

### Bug Fixes

- get discovery key from core.key ([25865bf](https://github.com/digidem/multi-core-indexer/commit/25865bffecc21083660471cdc74c409c7333fccd))

## [1.0.0-alpha.6](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.5...v1.0.0-alpha.6) (2023-08-30)

### ⚠ BREAKING CHANGES

- put storage in sub-folders (#17)

### Bug Fixes

- put storage in sub-folders ([#17](https://github.com/digidem/multi-core-indexer/issues/17)) ([3c13591](https://github.com/digidem/multi-core-indexer/commit/3c1359105a4fe2f87c9e9f4732e6ea51fa464c10)), closes [#16](https://github.com/digidem/multi-core-indexer/issues/16)

## [1.0.0-alpha.5](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.4...v1.0.0-alpha.5) (2023-08-23)

### Bug Fixes

- correctly track & persist index state ([#14](https://github.com/digidem/multi-core-indexer/issues/14)) ([c5bb0ce](https://github.com/digidem/multi-core-indexer/commit/c5bb0ce9755c2317538d28dbb2e037779f55695a))

## [1.0.0-alpha.4](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.3...v1.0.0-alpha.4) (2023-08-02)

## [1.0.0-alpha.3](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2023-08-02)

## [1.0.0-alpha.2](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.1...v1.0.0-alpha.2) (2023-07-06)

### Bug Fixes

- Fix for hypercore 10.6.0 change to update() ([#8](https://github.com/digidem/multi-core-indexer/issues/8)) ([0152d4b](https://github.com/digidem/multi-core-indexer/commit/0152d4b4a6499edaeae8150f353b93c8cb0bd140))

## [1.0.0-alpha.1](https://github.com/digidem/multi-core-indexer/compare/v1.0.0-alpha.0...v1.0.0-alpha.1) (2023-07-06)

### Features

- implement addCore method ([#3](https://github.com/digidem/multi-core-indexer/issues/3)) ([77999dc](https://github.com/digidem/multi-core-indexer/commit/77999dc89df171b15f04ec12d2d545de0f7ba4f4))
- state getter ([#5](https://github.com/digidem/multi-core-indexer/issues/5)) ([a4d7aa5](https://github.com/digidem/multi-core-indexer/commit/a4d7aa5e7eda71bc9e9a6ca92b96b5a1a5818bb6))

### Bug Fixes

- stricter types and publish typescript declarations ([#7](https://github.com/digidem/multi-core-indexer/issues/7)) ([adad201](https://github.com/digidem/multi-core-indexer/commit/adad201723b86add2f1ed7623c58d4eea7815ac8))

## 1.0.0-alpha.0 (2022-03-08)

### Bug Fixes

- only emit state when it changes ([7c62cc6](https://github.com/digidem/multi-core-indexer/commit/7c62cc6e7348e91e5b144c5da2913abec7dbeb01))
