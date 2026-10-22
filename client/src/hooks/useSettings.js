import { useSyncExternalStore } from 'react'
import { getSettings, subscribeToSettings } from '../utils/settings.js'

// The current settings; the component re-renders when they change.
export default function useSettings() {
  return useSyncExternalStore(subscribeToSettings, getSettings)
}
