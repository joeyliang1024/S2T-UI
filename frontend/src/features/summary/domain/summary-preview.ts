import type { SavedSession } from '../../../../shared/contracts/sessions'

/** Summary fields captured before a request replaced them on screen. */
export type SummaryPreviewOwner = {
  /** Last streaming fragment this request actually wrote to the record. */
  preview?: string
  previous: Pick<SavedSession, 'summary' | 'summaryState' | 'summaryError' | 'summarySourceSignature' | 'summarySourceVersionId' | 'summaryTranslation' | 'summaryTranslationTargetLanguage'>
}

/**
 * A streaming preview belongs only to the request that produced it. When that
 * request ends without committing — cancellation, provider failure, or a
 * transcript/audio version that changed mid-flight — the fragments already on
 * screen must roll back instead of masquerading as a finished summary and
 * silently replacing the previous one.
 *
 * Records the request never touched (or that a newer owner already rewrote)
 * are returned unchanged, so a late rollback cannot clobber live output.
 */
export const revertSummaryPreview = (entry: SavedSession, request: SummaryPreviewOwner): SavedSession =>
  request.preview === undefined || entry.summary !== request.preview
    ? entry
    : { ...entry, ...request.previous }
