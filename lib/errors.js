// @ts-check
import { createErrorClassesByName } from 'custom-error-creator'

// All errors created by this module. Each has a stable machine-readable
// `code` property, documented in the readme - match on that (or with
// instanceof via the `multi-core-indexer/error.js` export) rather than on
// the message. Errors wrapping an underlying failure carry it as `cause`.
export const {
  IndexerClosed,
  IndexerNotClosed,
  BatchError,
  HypercoreError,
  StorageError,
} = createErrorClassesByName([
  {
    code: 'INDEXER_CLOSED',
    message: 'Cannot {action} after closing',
  },
  {
    code: 'INDEXER_NOT_CLOSED',
    message: 'Cannot unlink until fully closed',
  },
  {
    code: 'BATCH_ERROR',
    message: 'The batch function threw or rejected',
  },
  {
    code: 'HYPERCORE_ERROR',
    message: 'Error reading from a hypercore',
  },
  {
    code: 'STORAGE_ERROR',
    message: 'Error reading or writing index state storage',
  },
])
