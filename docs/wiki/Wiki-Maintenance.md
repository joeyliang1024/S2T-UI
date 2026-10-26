# Wiki 維護與發布

## 單一來源與版本

開發規範與導航頁的可審查來源放在主 repo 的 `docs/wiki/`，GitHub Wiki 是發布面。操作 guide／reference／實驗證據維持在原來位置，Wiki 只摘要與導覽，不複製容易漂移的詳細操作。

新增頁使用 ASCII `Page-Name.md`，標題用繁中；一般頁連結寫 `[文件規範](Documentation-Standards)`。Home 是入口，`_Sidebar.md` 管理導覽，`_Footer.md` 管理共同版本提醒。新增頁要同步更新入口與側欄。

目前文件對應 Web／Python 工作分支；`manifest.json` 記錄 checkout 基準，未提交修改不代表遠端已發布。repo 連結使用明確 ref；分支合併或路徑移動後，更新 `manifest.json` 與頁面連結，再檢查遠端檔案確實存在。不能把只在本機的 feature／GPU 測試寫成已發布能力。

## 維護流程

1. 修改相關 `docs/wiki/*.md`，保持一個主題一頁。
2. 如果改的是 API、操作或數據，先更新其權威文件，再改 Wiki 摘要。
3. 執行 `node scripts/docs/wiki.cjs check`：檢查管理頁、內部頁面與 repo 路徑；這是離線檢查，不代表 GitHub 已可讀取新檔案。
4. 正常 PR 審查來源，確認 branch、指令與狀態描述；文件來源合併後再發布最容易追溯。
5. 獲授權發布時執行 `node scripts/docs/wiki.cjs publish`。工具只複製明列頁面、commit Wiki 並正常 push；不推送應用程式 checkout，不 force-push，不刪未知 Wiki 頁面。
6. 查看 GitHub Wiki 的 Home、側欄與關鍵連結；同步後記錄 Wiki commit。

若 Wiki 網頁已有人直接編輯，先把該修改帶回 repo 來源再發布；發布工具遇到來源與遠端內容無基準或不同步時會拒絕覆寫，需先檢查 diff；確認要採用 repo 版本後可加 `--adopt-existing`。第一次的 Home 初始化文字也必須先檢查再採用。

## 第一次建立

GitHub 必須先在網頁建立第一頁，才能 clone `https://github.com/joeyliang1024/S2T-UI.wiki.git`。若 repository metadata 的 `has_wiki=true` 但 wiki git 回傳不存在，先確認權限，再由擁有者到 Wiki 新增並保存 `Home`；內容可先寫「初始化」，之後由來源覆蓋。

此限制見 [GitHub 官方 Wiki 文件](https://docs.github.com/en/communities/documenting-your-project-with-wikis/adding-or-editing-wiki-pages)。Wiki 是獨立 git repository，不是主 repo 的 `wiki` branch，也不是 GitHub Pages。

發布需使用既有 git／gh 認證，不把 token 寫入 URL、腳本、log 或 repo。範例：`gh auth login` 由使用者自行完成；不在 automation prompt 或文件要求貼 token。
