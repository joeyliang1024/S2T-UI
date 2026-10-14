import type { SummaryProfile, SummaryStreamPort } from '../ports'
import { createDesktopSummaryPort } from './desktop-summary'
import { createWebSummaryPort } from './web-summary'

export const createSummaryPort = (profile: SummaryProfile): SummaryStreamPort => window.s2t
  ? createDesktopSummaryPort(profile, window.s2t)
  : createWebSummaryPort(profile)
