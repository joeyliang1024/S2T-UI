export type CaptionMetricSample = { stage: string; seconds: number }
export type CaptionMetricEvent = 'speech_detected' | 'asr_empty' | 'asr_failed' | 'audio_gap' | 'telemetry_dropped'
export type CaptionMetricPayload = { samples: CaptionMetricSample[]; events: Partial<Record<CaptionMetricEvent, number>> }

/** Best-effort metrics must not create a second unbounded request pipeline. */
export class CaptionMetricTransport {
  private batches: CaptionMetricSample[][] = []
  private sampleCount = 0
  private events: CaptionMetricPayload['events'] = {}
  private timer: ReturnType<typeof setTimeout> | undefined
  private sending = false
  private failures = 0
  private nextAttemptAt = 0

  constructor(private readonly send: (payload: CaptionMetricPayload) => Promise<boolean>, private readonly now: () => number = () => performance.now()) {}

  enqueue(samples: CaptionMetricSample[] = [], event?: CaptionMetricEvent): void {
    if (samples.length) { this.batches.push(samples); this.sampleCount += samples.length }
    while (this.sampleCount > 128) {
      this.sampleCount -= this.batches.shift()!.length
      this.addEvent('telemetry_dropped')
    }
    if (event) this.addEvent(event)
    this.arm()
  }

  private addEvent(event: CaptionMetricEvent, count = 1): void {
    const total = (this.events[event] || 0) + count
    this.events[event] = Math.min(1000, total)
    if (event !== 'telemetry_dropped' && total > 1000) this.addEvent('telemetry_dropped')
  }

  private arm(): void {
    if (this.sending || this.timer !== undefined || (!this.sampleCount && !Object.keys(this.events).length)) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush() }, Math.max(500, this.nextAttemptAt - this.now()))
  }

  private async flush(): Promise<void> {
    const payload: CaptionMetricPayload = { samples: this.batches.flat(), events: this.events }
    this.batches = []; this.sampleCount = 0; this.events = {}; this.sending = true
    let accepted = false
    try { accepted = await this.send(payload) } catch { /* A metrics failure never reaches the caption pipeline. */ }
    finally { this.sending = false }
    if (accepted) {
      this.failures = 0; this.nextAttemptAt = 0
      this.arm()
      return
    }
    // Do not replay histogram samples: the server may have accepted them even
    // if the response was lost. Only report a best-effort failure notification.
    this.addEvent('telemetry_dropped', 1 + (payload.events.telemetry_dropped || 0))
    this.failures = Math.min(5, this.failures + 1)
    this.nextAttemptAt = this.now() + Math.min(10_000, 500 * 2 ** this.failures)
    const freshWork = this.sampleCount > 0 || Object.keys(this.events).some(event => event !== 'telemetry_dropped')
    const failedWork = payload.samples.length > 0 || Object.keys(payload.events).some(event => event !== 'telemetry_dropped')
    // One notification after the final failed batch is useful. If that also
    // fails during an idle outage, stop polling until fresh input arrives.
    if (freshWork || failedWork) this.arm()
  }

  snapshot(): { queuedSamples: number; queuedBatches: number; inFlight: boolean; retryScheduled: boolean } {
    return { queuedSamples: this.sampleCount, queuedBatches: this.batches.length, inFlight: this.sending, retryScheduled: this.timer !== undefined }
  }
}
