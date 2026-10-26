import type { TextModelBinding, TextCompletionPort } from '../ports'
import { createWebTextPort } from './web-text'
export const createTextPort = (profile: TextModelBinding): TextCompletionPort => (createWebTextPort(profile))
