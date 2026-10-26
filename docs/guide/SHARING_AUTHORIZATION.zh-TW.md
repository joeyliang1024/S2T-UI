# 聲紋共享授權

繁體中文 | [English](../en/SHARING_AUTHORIZATION.md)

公開註冊的 NT／Department 是展示資料，不授予聲紋共享權限。Admin 在「設定 → 帳號管理」核准共享並指定可信部門。Admin 新建帳號會依其指定部門建立核准紀錄；公開註冊與舊帳號預設未核准，需逐一核實。

授權存於帳號的 sharing-authorization config record，保留 approvedBy／updatedAt；不用改既有帳號 schema。組織共享要求雙方已核准；部門共享還要求雙方可信部門一致。私人聲紋始終只有本人可見。撤銷授權立即影響後续比對查詢。

共享註冊仍需使用者明確同意。Admin 核准不代替個人 consent。舊共享資料不會因自報 Department 自動授予可見權限。

管理 API：GET/PUT `/api/admin/users/:id/sharing-authorization`；只有 admin 可呼叫。PUT 接受 `{ approved: boolean, department: string }`。
