# 翻譯術語 CSV / Translation jargon CSV

將正式檔案放在此目錄並命名 `jargon_en.csv`（不要把範例當成正式術語表）。
本機路徑為 `${S2T_DATA_DIR}/jargon/jargon_en.csv`，容器預設為
`/data/jargon/jargon_en.csv`。可用後端 `S2T_JARGON_FILE` 指定其他檔案。

Place the real `jargon_en.csv` here. Required columns: `jargon,az_jargon_listen`.
The real CSV is ignored by Git and excluded from Docker image builds.

- [繁體中文說明](../../docs/guide/TRANSLATION_JARGON.zh-TW.md)
- [English guide](../../docs/en/TRANSLATION_JARGON.md)
