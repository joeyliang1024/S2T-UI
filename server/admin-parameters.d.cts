export type AdminParameters = Partial<{minSpeechMs:number;minSilenceMs:number;preRollMs:number;noiseFloorOffsetDb:number;chunkMinMs:number;chunkMaxMs:number;translationAggregationMs:number;translationThrottledMs:number;translationSentenceWaitMs:number;translationConcurrency:number;translationTemperature:number}>
export const bounds: Record<keyof AdminParameters, [number,number]>
export function validateAdminParameters(value: unknown): AdminParameters | undefined
