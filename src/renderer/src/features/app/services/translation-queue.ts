import { registerTranslationTiming } from '../../../shared/services/caption-metrics'
import { groupLiveCaptions } from './live-caption'
import type { TranscriptEvent } from '../../models/model-adapter'
import { HttpServiceError } from '../../../shared/services/http'
import { activeTranslate } from '../../../shared/i18n'
import { maximumAutomaticTranslationQueue, maximumSentenceWaitMs, resolveTranslationTarget, shouldAutoTranslate, shouldSkipTranslation } from './translation-policy'

export type TranslateCaption = (entry: TranscriptEvent, signal: AbortSignal) => Promise<string>
type ActiveRequest = { promise: Promise<void>; controller: AbortController; generation: number }
type QueueOptions = { targetLanguage: string; strategy: 'realtime' | 'sentence'; elapsedMs: number }

export const matchesTranslationContent = (current: TranscriptEvent | undefined, requested: TranscriptEvent): boolean =>
  Boolean(current && current.id === requested.id && current.status === requested.status &&
    (current.translationContentRevision ?? 0) === (requested.translationContentRevision ?? 0) &&
    current.sourceText === requested.sourceText && current.detectedLanguage === requested.detectedLanguage &&
    current.translatedText === requested.translatedText)

/** Bounded workers; captions remain the durable pending queue. */
export class TranslationQueue {
  private active = new Map<string, ActiveRequest>()
  private retryAt = new Map<string, { revision: number; at: number }>()
  private generation = 0
  private blockedUntil = 0
  paused = false
  readonly diagnostics = { requests: 0, completed: 0, failedAttempts: 0, rateLimited: 0, staleResults: 0, peakConcurrent: 0, totalRequestMs: 0 }

  constructor(
    private readonly getEntries: () => TranscriptEvent[],
    private readonly updateEntries: (update: (entries: TranscriptEvent[]) => TranscriptEvent[]) => void,
    private readonly onError: (message: string) => void,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
  ) {}

  isActive(id: string): boolean { return this.active.has(id) }
  get inFlight(): number { return this.active.size }
  get retryCount(): number { return this.retryAt.size }
  get cooldownUntil(): number { return this.blockedUntil }

  private eligible(entry: TranscriptEvent, options: QueueOptions): boolean {
    return shouldAutoTranslate(entry, options.strategy, options.elapsedMs) &&
      !shouldSkipTranslation(entry.detectedLanguage, resolveTranslationTarget(entry.detectedLanguage, options.targetLanguage))
  }

  candidates(options: QueueOptions): TranscriptEvent[] {
    const entries = this.getEntries()
    const byId = new Map(entries.map((entry) => [entry.id, entry]))
    for (const [id, retry] of this.retryAt) {
      const entry = byId.get(id)
      if (!entry || entry.translatedText || entry.translationStatus || (entry.translationContentRevision ?? 0) !== retry.revision) this.retryAt.delete(id)
    }
    if (this.now() < this.blockedUntil) return []
    const pending = options.strategy === 'sentence'
      ? groupLiveCaptions(entries).flatMap((group, index, groups) => {
        if (group.members.some(member => member.translatedText || member.translationStatus)) return group.members.filter(member => this.eligible(member, options))
        const complete = group.isSentenceBoundary || index < groups.length - 1 || options.elapsedMs - group.endMs >= maximumSentenceWaitMs
        return complete && group.members.every(member => member.status === 'final') ? [group] : []
      }) : entries
    return pending.filter((entry) => this.eligible(entry, { ...options, strategy: 'realtime' }) && !this.active.has(entry.id) && this.now() >= (this.retryAt.get(entry.id)?.at ?? 0))
  }

  tick(options: QueueOptions, translate: TranslateCaption, throttled = false): void {
    if (this.paused) return
    const available = Math.max(0, maximumAutomaticTranslationQueue - this.active.size)
    const limit = throttled ? Math.min(1, available) : available
    this.candidates(options).slice(0, limit).forEach((entry) => { void this.request(entry, translate, options.targetLanguage) })
  }

  request(entry: TranscriptEvent, translate: TranslateCaption, targetLanguage: string): Promise<void> {
    const members = 'members' in entry ? (entry as TranscriptEvent & { members: TranscriptEvent[] }).members : [entry]
    const matchesMembers = (entries: TranscriptEvent[]): boolean => members.every(member => matchesTranslationContent(entries.find(current => current.id === member.id), member))
    const existing = this.active.get(entry.id)
    if (existing) return existing.promise
    if (this.active.size >= maximumAutomaticTranslationQueue || this.now() < this.blockedUntil ||
      shouldSkipTranslation(entry.detectedLanguage, resolveTranslationTarget(entry.detectedLanguage, targetLanguage)) ||
      !entry.sourceText.trim() || !matchesMembers(this.getEntries())) return Promise.resolve()
    if (members.length > 1) this.updateEntries(entries => entries.map(current => members.some(member => member.id === current.id) ? { ...current, captionGroupId: entry.id } : current))
    const controller = new AbortController()
    const generation = this.generation
    const startedAt = this.now()
    // Register before executing transport, including transports that throw
    // synchronously. This also makes immediate successive ticks safe.
    const request: ActiveRequest = { controller, generation, promise: Promise.resolve() }
    this.active.set(entry.id, request)
    this.diagnostics.peakConcurrent = Math.max(this.diagnostics.peakConcurrent, this.active.size)
    request.promise = Promise.resolve().then(async () => {
      if (generation !== this.generation || controller.signal.aborted) return
      this.diagnostics.requests += 1
      const transportStartedAt = performance.now()
      try {
        const text = (await this.abortable(translate(entry, controller.signal), controller.signal)).trim()
        if (!text) throw new Error(activeTranslate('svcTranslationEmptyResult'))
        if (generation !== this.generation || controller.signal.aborted) return
        const responseAt = performance.now()
        let applied = false
        this.updateEntries((entries) => {
          if (!matchesMembers(entries)) return entries
          applied = true
          registerTranslationTiming(entry.id, transportStartedAt, responseAt)
          return entries.map(current => members.some(member => member.id === current.id)
            ? { ...current, captionGroupId: entry.id, translatedText: current.id === entry.id ? text : undefined, translationStatus: 'completed' as const, translationAttempts: undefined, revision: current.revision + 1 }
            : current)
        })
        if (applied) this.diagnostics.completed += 1
        else this.diagnostics.staleResults += 1
        this.retryAt.delete(entry.id)
      } catch (error) {
        if (generation !== this.generation || controller.signal.aborted) return
        if (error instanceof HttpServiceError && error.status === 429) {
          this.diagnostics.rateLimited += 1
          this.blockedUntil = Math.max(this.blockedUntil, this.now() + (error.retryAfterSeconds ?? 30) * 1000)
          this.onError(activeTranslate('svcTranslationRateLimited').replace('{seconds}', String(Math.ceil((this.blockedUntil - this.now()) / 1000))))
          return
        }
        this.updateEntries((entries) => entries.map((current) => {
          if (!matchesMembers(entries) || !members.some(member => member.id === current.id)) return current
          const attempts = (current.translationAttempts ?? 0) + 1
          this.diagnostics.failedAttempts += 1
          const terminal = error instanceof HttpServiceError && [400, 401, 403, 404, 422].includes(error.status)
          if (terminal || attempts >= 3) {
            this.retryAt.delete(entry.id)
            return { ...current, translationAttempts: attempts, translationStatus: 'failed' }
          }
          this.retryAt.set(entry.id, { revision: current.translationContentRevision ?? 0, at: this.now() + attempts * 1000 })
          return { ...current, translationAttempts: attempts, translationStatus: undefined }
        }))
        this.onError(error instanceof Error ? error.message : activeTranslate('svcTranslationFailedRetry'))
      } finally {
        this.diagnostics.totalRequestMs += this.now() - startedAt
      }
    }).finally(() => {
      if (this.active.get(entry.id) === request) this.active.delete(entry.id)
    })
    return request.promise
  }

  /**
   * `markPendingFailed` only reports requests this queue actually started, so
   * the "cancel translations" action still hands the user a retry button for
   * whatever was in flight. Every other final caption is left alone: it may be
   * ineligible (source already equals target), never dispatched, or waiting on
   * a manual retry, and none of those had been attempted by anything.
   */
  reset(markPendingFailed = false): void {
    const abandoned = markPendingFailed ? [...this.active.keys()] : []
    this.generation += 1
    this.active.forEach((request) => request.controller.abort())
    this.retryAt.clear()
    this.blockedUntil = 0
    if (!abandoned.length) return
    const cancelled = new Set(abandoned)
    this.updateEntries((entries) => entries.map((entry) =>
      cancelled.has(entry.id) && entry.status === 'final' && entry.sourceText.trim() && !entry.translatedText
        ? { ...entry, translationStatus: 'failed' } : entry))
  }

  private async abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort: (reason: unknown) => void = () => undefined
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
    const cancel = (): void => rejectAbort(new DOMException(activeTranslate('svcTranslationCancelled'), 'AbortError'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    try { return await Promise.race([promise, aborted]) }
    finally { signal.removeEventListener('abort', cancel) }
  }

  async drain(options: QueueOptions, translate: TranslateCaption, timeoutMs = 60_000, includePending = true): Promise<boolean> {
    this.paused = true
    const deadline = this.now() + timeoutMs
    const generation = this.generation
    const finalOptions = { ...options, elapsedMs: Number.POSITIVE_INFINITY }
    while (generation === this.generation && this.now() < deadline) {
      // Fill all free workers without bypassing cooldowns or retries.
      if (includePending) this.candidates(finalOptions).slice(0, Math.max(0, maximumAutomaticTranslationQueue - this.active.size))
        .forEach((entry) => { void this.request(entry, translate, options.targetLanguage) })
      if (!this.active.size && (!includePending || !this.getEntries().some((entry) => this.eligible(entry, finalOptions)))) return true
      // Do not race Promise.all against a long timeout: poll with a short,
      // awaited timer so drain has no detached deadline timers to leak.
      await this.wait(Math.min(100, deadline - this.now()))
    }
    if (generation !== this.generation) return false
    this.reset(false)
    return false
  }
}
