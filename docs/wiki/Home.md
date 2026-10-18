# S2T-UI 開發 Wiki

這裡是開發者入口：說明功能要放哪裡、文件如何撰寫、如何驗證與維護 Wiki。操作細節與 API 契約仍以 repo 中對應文件為準。

更新日期：2026-10-17。開發結構核對基準為 `feat/bug-fix` 的 `071aeb62d1490aba3722d83440593c89fbee4abc`；當日 `main` 為較舊的 `32a0327f82a2043ef2c660367a6ca6032d7a6129`。切換分支前先確認工作目錄，不能拿 main 的舊路徑套用本頁的新結構。

| 需要做的事 | 入口 |
| --- | --- |
| 第一次開發與啟動 Web | [開發入門](Getting-Started) |
| 決定程式、工具、測試與文件放哪裡 | [目錄規範](Repository-Layout) |
| 開發、抽象、型別、非同步與 PR 規範 | [開發規範](Development-Standards) |
| 寫文件、選文件類別與使用範本 | [文件規範](Documentation-Standards) |
| 選測試、記錄證據與判定完成 | [測試與驗收](Testing-and-Validation) |
| Web 部署、模型、Storage 與疑難排解 | [部署與維運](Deployment-and-Operations) |
| 新增頁面、維護側欄、同步與發布 | [Wiki 維護](Wiki-Maintenance) |

目前工作優先為 Web，同源 gateway 對外 `8787`；Electron 專屬開發暫停，既有桌面契約仍需保留。新程式或新文件出現在工作目錄，不代表已合併、部署或驗收；本 Wiki 不代替發布紀錄。

待辦只維護一份：[剩餘開發與規格](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/Enhancement.md)。測試／真人驗收放 [驗收手冊](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/guide/VALIDATION.zh-TW.md)，不要複製成第二套 enhancement。已完成開發項目從待辦移除，證據留在 Git／reports／experiment。

完整文件入口：[repo 文件索引](https://github.com/joeyliang1024/S2T-UI/blob/feat/bug-fix/docs/README.md)。
