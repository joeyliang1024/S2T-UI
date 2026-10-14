export const sanitizeAsrText = (text: string): string =>
  text.replace(/<\|[^|]*\|>/g, ' ').replace(/\|\|/g, ' ').replace(/\s+/g, ' ').trim()

/** Conservative decoder-loop guard. Two repetitions can be ordinary speech;
 * reject only a fourfold phrase loop occupying most of the response. */
export const isRepetitiveAsrText = (text: string): boolean => {
  const characters = [...text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()]
  for (let size = 1; size <= Math.floor(characters.length / 4); size += 1) {
    for (let offset = 0; offset + size * 4 <= characters.length; offset += 1) {
      let end = offset + size
      while (end + size <= characters.length && characters.slice(offset, offset + size).every((character, index) => character === characters[end + index])) end += size
      const repeated = (end - offset) / size
      if (repeated >= (size === 1 ? 8 : 4) && end - offset >= characters.length * .8) return true
    }
  }
  return false
}

