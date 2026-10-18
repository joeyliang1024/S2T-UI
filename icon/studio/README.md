# Animated editorial artwork

Eight transparent foreground illustrations generated with the built-in imagegen tool.
The previous metallic audio ribbon has been replaced entirely.

| Asset | Page | Motion |
| --- | --- | --- |
| live.png | Login / live captions | Breathing microphone scene and animated sound bars; faster while recording |
| history.png | Recording archive | Light paper drift and sequential signal marks |
| summary.png | Meeting summary | Gentle notebook/paper movement |
| quality.png | Quality comparison | Alignment movement and scanning guide |
| models.png | Model management | Calibration movement and signal marks |
| voiceprints.png | Voiceprint management | Breathing illustration and expanding identity ring |
| settings.png | Preferences | Slow instrument movement |
| import.png | File import | Soft vertical intake movement |

Full final generation prompts: [artwork-generation.json](../../data/prompt/artwork-generation.json).
Each request used `transparent_background: true`. Original alpha is preserved.
The foreground artwork is bundled and fingerprinted by Vite and loaded by the pages
that use it. No external image host, image service or runtime API key is required.

`StudioArtwork` separates decorative layers from interactive content and live regions.
CSS animation never moves labels or hit targets. All artwork and live-navigation
animation stop with `prefers-reduced-motion: reduce`; paused recording pauses its
main illustration. UI text remains localized and is not embedded in raster art.
