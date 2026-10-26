import type { SummaryProfile, SummaryStreamPort } from '../ports'
import { createWebSummaryPort } from './web-summary'

export const createSummaryPort = (profile: SummaryProfile): SummaryStreamPort => (createWebSummaryPort(profile))
