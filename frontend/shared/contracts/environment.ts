export type EnvironmentModels = Partial<Record<'asr' | 'translation' | 'summary' | 'diarization', { endpoint: string; sourceEndpoint?: string; model: string; configured: boolean }>> & {
    diarizationProfiles?: Array<{ id: string; name: string; endpoint: string; model: string; configured: boolean }>
    branding?: { titleImage: string }
    prompts?: Record<string, string>
    asrProfiles?: Array<{ id: string; name: string; endpoint: string; sourceEndpoint?: string; model: string; configured: boolean }>
  }
