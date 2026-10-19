type DataPaths = { root: string; prompt: string; template: string }
export function dataPaths(environment?: NodeJS.ProcessEnv): DataPaths
export function initializeDataFiles(environment?: NodeJS.ProcessEnv, defaults?: string): DataPaths
