// Keep one logical event per subtitle ID, as the UI does. Boundary-only
// revisions close an existing caption; they must not repeat its text or
// move its initial display timestamp to the later boundary notification.
const recordTranscriptEvent = (events, event, displayWall) => {
  const index = events.findIndex((previous) => previous.id === event.id)
  if (index < 0) {
    if (!event.boundaryOnly) events.push({ ...event, displayWall })
    return
  }
  const previous = events[index]
  if (event.revision < previous.revision) return
  events[index] = {
    ...previous,
    ...event,
    sourceText: event.boundaryOnly ? previous.sourceText : event.sourceText,
    displayWall: previous.displayWall
  }
}

module.exports = { recordTranscriptEvent }
