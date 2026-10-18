# 開發與文件規範

目前優先開發 Web，同源 gateway 對外 `8787`；Electron 專屬開發暫停，保留既有契約。

- [GitHub Wiki](https://github.com/joeyliang1024/S2T-UI/wiki)：開發者導航與規範發布面。
- [程式與檔案放置](docs/wiki/Repository-Layout.md)
- [開發規範](docs/wiki/Development-Standards.md)
- [文件撰寫規範](docs/wiki/Documentation-Standards.md)
- [測試與完成定義](docs/wiki/Testing-and-Validation.md)
- [Wiki 維護與發布](docs/wiki/Wiki-Maintenance.md)

操作文件放 `docs/guide/`，契約放 `docs/reference/`，研究放 `docs/research/`，結果摘要放 `docs/reports/`，實驗紀錄放 `experiment/`；詳細檔案放置原則見上方連結。`docs/wiki/` 是 Wiki 可審查來源，不取代這些權威文件。

既有未提交修改不覆蓋；依目前 branch 的 package.json 選用驗證。程式、文件與必要測試在同一變更交付；mock／本機成功不能宣稱正式部署或模型品質驗收通過。剩餘開發與未決規格只維護在 [Enhancement](docs/Enhancement.md)。

文件變更可先執行 `node scripts/docs/wiki.cjs check`；主 repo 的 Git commit 與 Wiki 的 Git commit 是分開的，不要把整個應用程式工作目錄誤推到 Wiki。
