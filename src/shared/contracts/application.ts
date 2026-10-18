export type CaptureState = 'starting' | 'idle' | 'recording' | 'paused' | 'saving'
export type AudioDevice = { deviceId: string; label: string }
export type View = 'live' | 'history' | 'quality-comparison' | 'summary' | 'import' | 'models' | 'voiceprints' | 'settings'
