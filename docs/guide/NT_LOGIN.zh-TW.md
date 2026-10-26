# NT 登入

登入只需 NT 與密碼。註冊及管理員建立使用者時填寫 NT、密碼與部門；不再要求另外填寫 Account。管理頁以 NT 顯示、搜尋及確認刪除。

API 範例：`POST /api/auth/login` 傳送 `{"NT":"your.nt","password":"your-password"}`；建立使用者傳送 `{"NT":"your.nt","password":"your-password","Department":"engineering"}`。NT 去除前後空白，登入與唯一性檢查不分大小寫。密碼仍區分大小寫。

既有使用者直接使用已登記的 NT 登入，密碼與使用者 ID 不變，錄音、字幕、設定和授權維持原有歸屬。內部既有 username 儲存鍵及舊 API 格式暫時保留相容性；畫面和新請求不再使用第二個登入識別碼。NT 登入只比對 NT，不會把其他使用者的舊 Account 名稱當作 NT。

首次管理員初始化沿用 `S2T_BOOTSTRAP_ADMIN_USERNAME` 作為初始 NT；既有部署不需更改此環境變數名稱。
