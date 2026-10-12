import { responseSpeeds, type ResponseSpeed } from '../../capture/vad'

type Props = {
  speed: ResponseSpeed
  label: string
  labelColon: string
  hint: string
  fastLabel: string
  normalLabel: string
  slowLabel: string
  onChange: (speed: ResponseSpeed) => void
}

export const ResponseSpeedControl = ({ speed, label, labelColon, hint, fastLabel, normalLabel, slowLabel, onChange }: Props) => {
  const selectedLabel = speed === 'fast' ? fastLabel : speed === 'normal' ? normalLabel : speed === 'slow' ? slowLabel : undefined
  const position = responseSpeeds.indexOf(speed)
  return <label className="quick-settings-speed" title={hint}>
    {label}{selectedLabel && <>{labelColon}{selectedLabel}</>}
    <input type="range" min="0" max={responseSpeeds.length - 1} step="1" value={position}
      aria-label={label} aria-valuetext={selectedLabel ?? `${position + 1}/${responseSpeeds.length}`}
      onChange={event => onChange(responseSpeeds[Number(event.target.value)] ?? 'normal')} />
    <span className="quick-settings-speed-scale" aria-hidden="true"><span>{fastLabel}</span><span>{normalLabel}</span><span>{slowLabel}</span></span>
  </label>
}
