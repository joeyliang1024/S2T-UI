import defaults from '../../../../../data/prompt/prompts.json'
let catalog = { ...defaults }
export type PromptId = keyof typeof defaults
export const setPromptCatalog = (value?: Record<string, string>): void => {
  if (!value) { catalog = { ...defaults }; return }
  const next = { ...defaults }
  for (const key of Object.keys(defaults) as PromptId[]) {
    if (typeof value[key] !== 'string' || !value[key].trim()) throw new Error(`Invalid prompt: ${key}`)
    const required = [...defaults[key].matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1])
    if (required.some(name => !value[key].includes(`{{${name}}}`))) throw new Error(`Missing prompt variable: ${key}`)
    next[key] = value[key]
  }
  catalog = next
}
export const prompt = (id: PromptId, variables: Record<string, string | number> = {}): string =>
  catalog[id].replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    if (!Object.hasOwn(variables, name)) throw new Error(`Missing prompt variable: ${id}.${name}`)
    return String(variables[name])
  })
