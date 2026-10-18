# Runtime model prompts

All built-in model instructions are defined in `prompts.json`: summary generation,
chunk summarization/compression/merge, recording titles, and plain/Markdown translation
for both desktop and Gateway transports.

Set `DATA_DIR=/data`. On first access the application creates `/data/prompt` and
`/data/template` and copies missing bundled defaults. Existing prompt files, shared
Markdown templates, account data and authentication secrets are not overwritten.
The source directories shipped in the image are defaults; edit the persistent
`$DATA_DIR/prompt/prompts.json` to configure the running installation.

Keep every prompt key and its `{{variable}}` placeholders. Values must be nonempty
strings. Substitution is one pass: transcript/glossary/template contents are never
interpreted as additional placeholders. Invalid files produce an explicit error.
Gateway translation reads the file for each request; browser/desktop prompt catalogs
are refreshed when the application loads (reload the page after editing).
Do not put credentials in prompts: the catalog is delivered to the frontend.

ASR glossary/context and user-selected summary templates remain account/record data;
they are inserted into these templates at runtime, not saved as shared instructions.

For compatibility, installations without `DATA_DIR` retain `S2T_LOCAL_DATA_DIR`
(or `.s2t-data`) and `S2T_SUMMARY_TEMPLATES_DIR`. Once `DATA_DIR` is supplied it
wins and both child paths are derived automatically. To move an existing installation,
stop the service, copy its entire data directory (including `auth-secret`) to the new
root, copy any separately mounted templates into `template/`, then set `DATA_DIR`.
The Docker Compose configuration already uses the existing `/data` persistent volume.
