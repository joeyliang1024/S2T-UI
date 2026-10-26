# Caption-row merging — 2026-10-26

The user clarified that rows already merge, but remain too fragmented. Capture settings are restored: Normal uses a three-second limit and 250ms silence; all five presets retain their original values.

Only the display punctuation split threshold changes from 24 to 40 non-whitespace/non-punctuation characters. A shorter punctuated row can accept the next compatible chunk. Explicit speech boundaries, frozen group membership, speaker/language changes, timing gaps, and existing ten-second/70-character guards remain enforced. Other rules may still split a row; elimination of all fragmentation is not claimed. Model inference, translation requests and canonical storage are unchanged.

Regression coverage includes punctuated 24–39-character fragments merging, 40-character punctuated rows splitting, explicit boundaries, and speaker-freeze consistency. All 54 frontend tests, type checking, architecture checks and build passed. Frontend r16 replaces r15; backend remains r24. The earlier four-second local Whisper experiment is historical and does not measure this display-only change.

The deployed browser integration suite passed recording, captions, translation, background processing, WAV persistence, logout and test-user cleanup. It uses existing mock endpoints and establishes integration behavior, not recognition accuracy.
