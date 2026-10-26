# Animated layered artwork

The eight page illustrations share matte charcoal panels, thin theme-colored edges,
a restrained accent tile, and a small page-specific motif. They replace the previous
paper illustrations. Each PNG has a transparent background and is bundled locally
by Vite; no image host or runtime image-generation service is needed.

| Asset | Page | Edge/accent color |
| --- | --- | --- |
| live.png | Login / live captions | Blue `#8caeff` |
| history.png | Recording archive | Apricot `#edab82` |
| summary.png | Meeting summary | Lavender `#baa4ed` |
| quality.png | Quality comparison | Mint `#82d2b5` |
| models.png | Model management | Slate blue `#93baff` |
| voiceprints.png | Voiceprint management | Rose `#e7a3bd` |
| settings.png | Preferences | Teal `#92c7c6` |
| import.png | File import | Sand `#e0c084` |

Generation specifications: [artwork-generation.json](../../backend/resources/prompt/artwork-generation.json).
The approved dark-panel concept was used as a style reference for each asset.

`StudioArtwork` supplies gentle transform-based floating motion and a separate,
subtle accent-light layer. Live captions also have small animated signal strokes;
their pace increases while recording. Decorative animation never moves controls,
labels or hit targets. Pausing capture pauses its artwork. All artwork animation is
disabled for `prefers-reduced-motion: reduce`. Text is localized in the interface,
not embedded in the images. Both light and dark interface themes use the same
transparent charcoal foreground, without a baked-in rectangular background.
