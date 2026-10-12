export type ResponseSpeed = 'fast' | 'fast-normal' | 'normal' | 'normal-slow' | 'slow'

export const responseSpeeds: ReadonlyArray<ResponseSpeed> = ['fast', 'fast-normal', 'normal', 'normal-slow', 'slow']

export const normalizeResponseSpeed = (value: unknown): ResponseSpeed =>
  responseSpeeds.includes(value as ResponseSpeed) ? value as ResponseSpeed : 'normal'
