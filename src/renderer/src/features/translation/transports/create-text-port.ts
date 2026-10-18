import type { TextModelBinding, TextCompletionPort } from '../ports'
import { createWebTextPort } from './web-text'
import { createDesktopTextPort } from './desktop-text'
export const createTextPort = (profile: TextModelBinding): TextCompletionPort => window.s2t ? createDesktopTextPort(profile, window.s2t) : createWebTextPort(profile)
