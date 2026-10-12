const assert = require('node:assert/strict')
const { buildSync } = require('esbuild')
const { renderToStaticMarkup } = require('react-dom/server')
const React = require('react')
const load = entry => {
  const bundle = buildSync({ entryPoints: [entry], bundle: true, format: 'cjs', platform: 'node', packages: 'external', write: false })
  const loaded = new module.constructor(entry)
  loaded.paths = module.paths
  loaded._compile(bundle.outputFiles[0].text, entry + '.cjs')
  return loaded.exports
}
const { normalizeSettings } = load('src/renderer/src/shared/services/settings.ts')
const { ResponseSpeedControl } = load('src/renderer/src/features/app/views/ResponseSpeedControl.tsx')
const values = ['fast', 'fast-normal', 'normal', 'normal-slow', 'slow']
for (const [index, speed] of values.entries()) {
  const restored = normalizeSettings(JSON.parse(JSON.stringify({ responseSpeed: speed })))
  assert.equal(restored.responseSpeed, speed, 'all five positions must survive settings serialization')
  const html = renderToStaticMarkup(React.createElement(ResponseSpeedControl, {
    speed, label: 'Response speed', labelColon: ':', hint: 'Speed and accuracy',
    fastLabel: 'Fast', normalLabel: 'Normal', slowLabel: 'Slow', onChange: () => {}
  }))
  assert.match(html, /max="4"/)
  assert.match(html, /step="1"/)
  assert.match(html, new RegExp(`value="${index}"`))
  if (index === 1 || index === 3) {
    assert.match(html, new RegExp(`aria-valuetext="${index + 1}/5"`), 'unlabeled positions remain accessible')
    assert.match(html, />Response speed<input/, 'intermediate positions must not display a selected name')
    assert.equal((html.match(/>Normal</g) || []).length, 1, 'only the center scale label displays Normal')
  }
}
assert.equal(normalizeSettings({ responseSpeed: 'unknown' }).responseSpeed, 'normal')
console.log('Five-position speed control, unlabeled intermediates and saved settings migration passed.')
