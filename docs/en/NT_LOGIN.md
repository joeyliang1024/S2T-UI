# NT login

Sign in with NT and password. Registration and administrator-created users require NT, password and department; there is no separate Account field. Administration displays NT, searches by NT or department, and confirms deletion by NT.

`POST /api/auth/login`: `{"NT":"your.nt","password":"your-password"}`. Registration: `{"NT":"your.nt","password":"your-password","Department":"engineering"}`. NT is trimmed and compared case-insensitively; passwords remain case-sensitive.

Existing users sign in with their recorded NT and existing password. User IDs and ownership of recordings, transcripts, settings and authorizations remain unchanged. Legacy username storage keys and API payloads remain compatible internally; the UI and new requests use NT. NT login never treats another user's legacy Account alias as an NT match.

For bootstrap compatibility, `S2T_BOOTSTRAP_ADMIN_USERNAME` continues to supply the initial administrator NT; existing deployments do not need to rename this environment variable.
