import { type FormEvent, type ReactElement, useState } from 'react'

export function SpeakerBatchRename({ speakerLabel, renameToLabel, renameActionLabel, unassignedLabel, nameLabel, rename }: {
  speakerLabel: string
  renameToLabel: string
  renameActionLabel: string
  unassignedLabel: string
  nameLabel: string
  rename: (from: string, to: string) => void
}): ReactElement {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    rename(from, to)
    setFrom('')
    setTo('')
  }
  return <form className="speaker-batch-rename" onSubmit={submit}>
    <label>{speakerLabel}<input list="registered-speakers" value={from} placeholder={unassignedLabel} onChange={(event) => setFrom(event.target.value)} /></label>
    <label>{renameToLabel}<input list="registered-speakers" value={to} placeholder={nameLabel} onChange={(event) => setTo(event.target.value)} /></label>
    <button className="text-button" type="submit">{renameActionLabel}</button>
  </form>
}
