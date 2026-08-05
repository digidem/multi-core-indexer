// @ts-check
import { createErrorClassesByName } from 'custom-error-creator'

// All errors created by this module. Each has a stable machine-readable
// `code` property, documented in the readme - match on that rather than on
// the message.
export const {
  IndexerClosed,
  IndexerNotClosed,
  MissingCoreKey,
  MissingDiscoveryKey,
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
    code: 'MISSING_CORE_KEY',
    message: 'Missing core key',
  },
  {
    code: 'MISSING_DISCOVERY_KEY',
    message: 'Missing discovery key',
  },
])
