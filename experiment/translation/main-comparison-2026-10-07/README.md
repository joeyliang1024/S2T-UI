# main vs feature translation comparison, 2026-10-07

Baseline remote main ed725a1, feature 5b51249. The real TypeScript TranslationQueue from each branch was bundled and fed identical 24 caption chunks. Both realtime and sentence strategies were tested at deterministic mock response delays of 180, 800 and 2500 ms. This first experiment isolates queue scheduling and request text, not model quality, ASR segmentation, Gateway or UI paint.

| Model delay | Realtime P95, main / feature | Sentence P95, main / feature |
| --- | --- | --- |
| 180 ms | 200 / 200 ms | 3800 / 3800 ms |
| 800 ms | 800 / 800 ms | 4400 / 4400 ms |
| 2500 ms | 4150 / 4150 ms | 6100 / 6100 ms |

Realtime issued 24 requests, sentence issued 6. Both completed all 24 source captions with exactly the same request text and timing. The source-coverage check only detects omissions/duplication; it does not judge translated meaning. Translation prompt, temperature and mode policy have not changed. Caption grouping locks and distributed Gateway coordination differ and require separate integration comparison.

Read-only inspection found the current 8790 environment default is `mock-translation`. Admin's persisted selection points to that environment default and realtime mode. This does not establish the model used by another account or another site. Real quality comparison requires identifying the affected real model/account. No real API was called in this experiment.

Re-run: export origin/main's src/renderer/src into `/tmp/s2t-translation-main-20261007` without changing the current checkout, then `node experiment/translation/main-comparison-2026-10-07/queue-compare.cjs`. Use `S2T_MAIN_SNAPSHOT` to override snapshot path. Results retain actual request inputs for review.
