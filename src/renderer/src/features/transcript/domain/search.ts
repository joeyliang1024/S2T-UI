import type { TranscriptEvent } from '../../models/model-adapter'
import { groupLiveCaptions, type LiveCaptionGroup } from './live-caption'
import type { TextSearch } from '../../../shared/services/search'

export const captionSearchValues = (group: LiveCaptionGroup): Array<string | undefined> => [group.sourceText, group.translatedText, group.speaker, ...group.members.map(member => member.speaker)]

/** Match visible groups, keeping every member so filtering cannot regroup sentences. */
export const searchCaptionGroups = (entries: TranscriptEvent[], search: TextSearch): LiveCaptionGroup[] =>
  groupLiveCaptions(entries).filter(group => group.status !== 'gap' && search.matches(...captionSearchValues(group)))
