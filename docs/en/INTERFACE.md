# Interface and media import

[繁體中文](../reference/INTERFACE.zh-TW.md) | English

The live toolbar provides text size, history, capture controls, speaker marking and a separate caption window. Sidebar icons share SVG styling, themed borders, keyboard/hover states and reduced-motion handling. Product title assets use `S2T_PRODUCT_TITLE_IMAGE` in backend configuration; unreadable/empty assets fall back to text. Favicon assets are bundled from `icon/favicon.svg`.

PCM16 WAV imports retain 45-second chunks, 1.5-second overlap and resume behavior. Other supported audio/video formats use authenticated Python FFmpeg conversion to mono 16kHz PCM16 WAV before ASR. Video uses its first audio stream. Input/converted WAV limits are 2GB; conversion is bounded, cancellable and cleans temporary files. Full 2GB stress acceptance has not been performed. See the Chinese reference for the complete extension list and implementation limits.

NT/password is the visible login identity. Normal live capture remains three seconds; compatible short caption fragments merge according to [caption speed](CAPTION_SPEED.md). Raw records and exports keep canonical events. [Validation](VALIDATION.md) covers integration rather than codec-specific recognition quality.
