# Code skills 分享簡報

15 分鐘的 code-review 與 code-scan 工具分享。

- [可編輯 PowerPoint](EVA-code-skills-terminal.pptx)：11 張，包含主封面、兩張 skill 章節封面與講者備註。
- [封面預覽](EVA-terminal-cover.png)
- [生成原始碼](EVA-ppt-source.zip)：JavaScript、11 張 HTML、備註資料、套件清理腳本與執行說明。

## 設計

深色底，搭配 EVA 紅、暖白、鮮綠、紫。內容以圓角細框卡片呈現，加入終端機視窗與等寬英文。

## 素材待補

1. check、review、audit 的實際使用情境與檢查範圍。
2. subagent 真實分工與 code-graph 關聯案例。
3. code-review 的 60 秒 demo 或關鍵截圖。
4. code-scan 用途與兩個功能／模式。
5. code-scan 的 60 秒 demo 或關鍵截圖。
6. 工具、文件、安裝方式、第一次執行指令與回饋管道。

每個 demo 聚焦一個已確認的發現，並準備輸入指令、關鍵發現與最後結果的備用截圖。完整影片放在使用文件。

## 重新生成

解壓縮原始碼，閱讀其中 README.md。使用 PptxGenJS 與 pptx skill 的 html2pptx.js，需要 Node.js、Playwright、Sharp 與 Chrome。來源中的執行路徑是原製作電腦的路徑，換電腦時須調整。

封面終端機中的指令是視覺示意；工具的真實執行指令需另行填入。
