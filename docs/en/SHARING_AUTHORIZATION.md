# Voiceprint sharing authorization

[繁體中文](../guide/SHARING_AUTHORIZATION.zh-TW.md) | English

Publicly supplied NT and Department are display metadata and cannot grant voiceprint sharing. An administrator approves sharing and assigns a trusted department in account management. Organization sharing requires both parties approved; department sharing also requires equal trusted departments. Private voiceprints remain owner-only. Revocation affects subsequent matching requests.

User consent remains required: admin approval does not replace it. Public registration and legacy users are unapproved until verified. Authorization records preserve approval actor/time without granting rights from the user's own Department field.

Only admins can GET/PUT `/api/admin/users/:id/sharing-authorization`. PUT accepts `{ "approved": true, "department": "trusted department" }`. See [API](API.md) and [NT login](NT_LOGIN.md).
