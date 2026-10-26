# Translation jargon CSV

Every `POST /api/translations` checks the latest shared CSV and keeps only rows
whose `jargon` is a case-sensitive substring of the source text. Matching rows
become `jargon->az_jargon_listen`, joined with newlines in CSV order. There is no
word-boundary matching. Repeated source occurrences do not duplicate a CSV row;
duplicate CSV rows are preserved.

When no rows match, the exact replacement is:

```text
本次無匹配術語, 請依據場內情境自由發揮專業翻譯
```

The required headers are `jargon,az_jargon_listen`. UTF-8 BOM, quoted commas and
quoted multiline fields are supported. Blank terms or translations are skipped.
See [the example](../../data/jargon/jargon_en.csv.example); sample terms are never
loaded automatically.

## File location and deployment

- Local: `${S2T_DATA_DIR}/jargon/jargon_en.csv`, normally `data/jargon/jargon_en.csv`.
- Compose: `/data/jargon/jargon_en.csv` in the existing data mount.
- Backend override: `S2T_JARGON_FILE`.
- Kubernetes: `npm run k8s:up` packages the local CSV into the `s2t-jargon`
  ConfigMap mounted read-only at `/data/jargon` in every backend Pod. Use
  `K8S_JARGON_FILE` to select another deployment source. After editing the local
  CSV, deploy again or update the ConfigMap directly. Direct updates take time to
  propagate to mounted volumes.
- Files larger than 900 KiB: set `K8S_JARGON_PVC` to an existing shared PVC with
  `jargon_en.csv` at its root. All backend Pods must be able to read it concurrently.

Each request checks the file version. Unchanged files reuse parsed rows; file I/O
and parsing run in a worker thread. Each Pod maintains its own cache and reloads
when the shared mount changes. Pods can briefly observe different revisions while
Kubernetes propagates an update. Prefer atomic file replacement.

A missing or removed file uses the no-match instruction. An unreadable or malformed
existing CSV returns HTTP 503 instead of silently using stale terminology. The real
CSV is excluded from Git and Docker builds.

## Prompt placeholders

Both gateway translation prompts include `{glossary}`. `{{glossary}}` is also
supported. Rendering is a single pass, so braces in source text or CSV values do
not trigger further substitution. Markdown translation uses the same path.

Existing account terminology stays in `{{terms}}`. Customized persisted templates
are not overwritten. For legacy templates without a glossary placeholder, matched
CSV terms are appended to `{{terms}}`. A custom template needs `{glossary}`,
`{{glossary}}` or `{{terms}}` to include the CSV result.
