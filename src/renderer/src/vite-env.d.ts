/// <reference types="vite/client" />
import type { DesktopBridge, EnvironmentModels as SharedEnvironmentModels } from '../../shared/contracts/desktop'
export {}
declare global {
  type EnvironmentModels = SharedEnvironmentModels
  interface Window { s2t?: DesktopBridge }
}
