import type { SproutbookApi } from '../shared/api'

declare global {
  interface Window {
    api: SproutbookApi
  }
}

export {}
