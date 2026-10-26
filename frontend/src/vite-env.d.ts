/// <reference types="vite/client" />
import type { EnvironmentModels as SharedEnvironmentModels } from '../shared/contracts/environment'
export {}
declare global {
  type EnvironmentModels = SharedEnvironmentModels
}
