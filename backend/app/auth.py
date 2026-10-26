import base64
import hashlib
import re
import secrets
import time
import uuid

import anyio
import bcrypt
import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .core import fail, now


def public_user(user):
    return {
        **{
            key: user[key]
            for key in ("id", "username", "NT", "Department", "createdAt", "deletionState")
            if key in user
        },
        "role": user.get("role") if user.get("role") in {"admin", "developer"} else "user",
    }


def username(value):
    result = value.strip().lower() if isinstance(value, str) else ""
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,63}", result):
        fail(400, "帳號需為 3 至 64 個英數字、點、底線或連字號")
    return result


def nt_identity(value):
    result = value.strip() if isinstance(value, str) else ""
    if not result or len(result) > 256 or any(ord(char) < 32 for char in result):
        fail(400, "NT 為必填，最多 256 字元且不可包含控制字元")
    return result


def encode64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def decode64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class Auth:
    def __init__(self, storage, settings):
        self.storage, self.settings = storage, settings
        self.hash_gate = anyio.CapacityLimiter(4)
        self.secret = settings.env.get("S2T_AUTH_SECRET", "").strip()

    async def open(self):
        if not self.secret:
            file = self.settings.root / "auth-secret"
            try:
                self.secret = file.read_text().strip()
            except FileNotFoundError:
                value = secrets.token_urlsafe(48)
                try:
                    with file.open("x") as output:
                        import os

                        os.chmod(file, 0o600)
                        output.write(value)
                    self.secret = value
                except FileExistsError:
                    self.secret = file.read_text().strip()
        if not await self.admin():
            name = self.settings.env.get("S2T_BOOTSTRAP_ADMIN_USERNAME", "").strip() or "admin"
            password = self.settings.env.get("S2T_BOOTSTRAP_ADMIN_PASSWORD", "")
            development = (
                not self.settings.production
                and self.settings.env.get("S2T_ALLOW_DEFAULT_ADMIN") == "true"
            )
            retirement = (
                "retired-bootstrap-" + hashlib.sha256(name.lower().encode()).hexdigest()[:40]
            )
            if await self.storage.get("auth", retirement):
                fail(503, "Bootstrap admin 已停用，請設定新的管理帳號")
            if not password and development:
                password = "admin"
            if not password or (self.settings.production and len(password) < 12):
                raise ValueError("首次啟動必須設定 bootstrap 帳號及至少 12 字元的正式環境密碼")
            try:
                admin = await self.create(
                    {
                        "username": name,
                        "password": password,
                        "NT": name,
                        "Department": "admin",
                        "role": "admin",
                    },
                    bootstrap=True,
                )
                await self.storage.put(
                    admin["id"],
                    "sharing-authorization",
                    {
                        "approved": True,
                        "department": "admin",
                        "approvedBy": admin["id"],
                        "updatedAt": now(),
                    },
                )
            except Exception:
                if not await self.admin():
                    raise
        async with self.storage.transaction("auth-accounts") as tx:
            admins = sorted(
                [
                    user
                    for user in await self.accounts(tx)
                    if user.get("role") == "admin" and user.get("deletionState") != "deleting"
                ],
                key=lambda user: (user["createdAt"], user["id"]),
            )
            for user in admins[1:]:
                user["role"] = "developer"
                await self.save_account(tx, user)
            if hasattr(tx, "connection"):
                await tx.connection.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS s2t_users_single_admin_index ON s2t_users(role) WHERE role='admin'"
                )
            elif admins:
                await tx.put("auth", "singleton-admin", admins[0]["id"])

    async def accounts(self, tx=None):
        if tx is None:
            async with self.storage.transaction("auth-accounts") as current:
                return await self.accounts(current)
        if hasattr(tx, "connection"):
            rows = await (
                await tx.connection.execute(
                    "SELECT id,username,password_hash,nt,department,role,created_at,deletion_state FROM s2t_users ORDER BY created_at,id"
                )
            ).fetchall()
            return [
                dict(
                    zip(
                        (
                            "id",
                            "username",
                            "passwordHash",
                            "NT",
                            "Department",
                            "role",
                            "createdAt",
                            "deletionState",
                        ),
                        (*row[:6], row[6].isoformat(), row[7]),
                    )
                )
                for row in rows
            ]
        return [entry["value"] for entry in await tx.list("auth", "account-")]

    async def account(self, user_id=None, name=None, tx=None, nt=None):
        if self.storage.pool and tx is None:
            async with self.storage.pool.connection() as connection:
                field, value = (("id", user_id) if user_id is not None else
                                ("lower(nt)", nt.lower()) if nt is not None else ("username", name))
                row = await (
                    await connection.execute(
                        f"SELECT id,username,password_hash,nt,department,role,created_at,deletion_state FROM s2t_users WHERE {field}=%s",
                        (value,),
                    )
                ).fetchone()
                if not row:
                    return None
                return dict(
                    zip(
                        (
                            "id",
                            "username",
                            "passwordHash",
                            "NT",
                            "Department",
                            "role",
                            "createdAt",
                            "deletionState",
                        ),
                        (*row[:6], row[6].isoformat(), row[7]),
                    )
                )
        return next(
            (
                item
                for item in await self.accounts(tx)
                if item["id"] == user_id or (name is not None and item["username"] == name)
                or (nt is not None and item["NT"].lower() == nt.lower())
            ),
            None,
        )

    async def admin(self):
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                row = await (
                    await connection.execute(
                        "SELECT id FROM s2t_users WHERE role='admin' AND deletion_state='active' ORDER BY created_at,id LIMIT 1"
                    )
                ).fetchone()
                return {"id": row[0]} if row else None
        return next(
            (
                user
                for user in await self.accounts()
                if user.get("role") == "admin" and user.get("deletionState") != "deleting"
            ),
            None,
        )

    async def owner(self):
        user = await self.admin()
        if not user:
            fail(503, "共用模型管理帳號不可用")
        return user["id"]

    async def save_account(self, tx, user):
        if hasattr(tx, "connection"):
            await tx.connection.execute(
                "UPDATE s2t_users SET role=%s,deletion_state=%s,updated_at=now() WHERE id=%s",
                (user["role"], user.get("deletionState", "active"), user["id"]),
            )
        else:
            await tx.put("auth", "account-" + user["username"], user)

    async def create(self, data, bootstrap=False):
        nt = nt_identity(data.get("NT"))
        # Legacy username remains an internal storage key; new clients supply only NT.
        name = username(data["username"]) if "username" in data else (
            "nt-" + hashlib.sha256(nt.lower().encode()).hexdigest()[:40]
        )
        password = data.get("password")
        if (
            not isinstance(password, str)
            or not password
            or len(password.encode()) > 72
            or (not bootstrap and len(password) < 8)
        ):
            fail(400, "密碼須為 8 至 72 bytes")
        nt, department = data.get("NT"), data.get("Department")
        if (
            not isinstance(nt, str)
            or not nt.strip()
            or not isinstance(department, str)
            or not department.strip()
        ):
            fail(400, "NT 與 Department 為必填")
        role = data.get("role", "user")
        if role not in ({"admin"} if bootstrap else {"developer", "user"}):
            fail(400, "只能建立 developer 或 user")
        password_hash = await anyio.to_thread.run_sync(
            lambda: bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=12)).decode(),
            limiter=self.hash_gate,
        )
        user = dict(
            id=str(uuid.uuid4()),
            username=name,
            passwordHash=password_hash,
            NT=nt.strip()[:256],
            Department=department.strip()[:256],
            role=role,
            createdAt=now(),
            deletionState="active",
        )
        async with self.storage.transaction("auth-accounts") as tx:
            users = await self.accounts(tx)
            if any(item["username"] == name for item in users):
                fail(409, "帳號已存在")
            if any(item["NT"].lower() == user["NT"].lower() for item in users):
                fail(409, "NT 已存在")
            if role == "admin" and any(item.get("role") == "admin" for item in users):
                fail(409, "admin 帳號只能有一個")
            if hasattr(tx, "connection"):
                await tx.connection.execute(
                    "INSERT INTO s2t_users(id,username,password_hash,nt,department,role,created_at) VALUES(%s,%s,%s,%s,%s,%s,%s)",
                    tuple(
                        user[key]
                        for key in (
                            "id",
                            "username",
                            "passwordHash",
                            "NT",
                            "Department",
                            "role",
                            "createdAt",
                        )
                    ),
                )
            else:
                await tx.put("auth", "account-" + name, user)
                reservation = "nt-" + hashlib.sha256(user["NT"].lower().encode()).hexdigest()[:40]
                await tx.put("auth", reservation, user["id"])
                if role == "admin":
                    await tx.put("auth", "singleton-admin", user["id"])
        return public_user(user)

    def issue(self, user):
        return jwt.encode(
            {
                "sub": user["id"],
                "iat": int(time.time()),
                "exp": int(time.time()) + 604800,
                "jti": secrets.token_urlsafe(18),
            },
            self.secret,
            algorithm="HS256",
        )

    async def login(self, data):
        user = (await self.account(nt=nt_identity(data["NT"])) if "NT" in data
                else await self.account(name=username(data.get("username"))))
        password = data.get("password", "")
        if not isinstance(password, str) or len(password.encode()) > 72:
            fail(401, "帳號或密碼錯誤")
        # Run the expensive check off-loop and cap parallel hashes.
        valid = (
            user
            and user.get("deletionState") != "deleting"
            and await anyio.to_thread.run_sync(
                lambda: bcrypt.checkpw(password.encode(), user["passwordHash"].encode()),
                limiter=self.hash_gate,
            )
        )
        if not valid:
            fail(401, "帳號或密碼錯誤")
        return public_user(user)

    def payload(self, token):
        try:
            value = jwt.decode(
                token, self.secret, algorithms=["HS256"], options={"require": ["exp", "sub", "jti"]}
            )
            return (
                value
                if isinstance(value.get("sub"), str) and isinstance(value.get("jti"), str)
                else None
            )
        except jwt.PyJWTError:
            return None

    async def session(self, token):
        payload = self.payload(token)
        if not payload:
            return None
        if self.storage.pool:
            async with self.storage.pool.connection() as connection:
                row = await (
                    await connection.execute(
                        "SELECT u.id,u.username,u.nt,u.department,u.role,u.created_at,u.deletion_state,r.value FROM s2t_users u LEFT JOIN s2t_config_records r ON r.scope=u.id AND r.record_key='revoked-auth-tokens' WHERE u.id=%s",
                        (payload["sub"],),
                    )
                ).fetchone()
            if (
                not row
                or row[6] == "deleting"
                or any(
                    item.get("jti") == payload["jti"] and item.get("expiresAt", 0) > time.time()
                    for item in (row[7] or [])
                )
            ):
                return None
            return dict(
                zip(
                    ("id", "username", "NT", "Department", "role", "createdAt"),
                    (*row[:5], row[5].isoformat()),
                )
            )
        async with self.storage.transaction() as tx:
            user = await self.account(user_id=payload["sub"], tx=tx)
            revoked = await tx.get(payload["sub"], "revoked-auth-tokens") or []
            if (
                not user
                or user.get("deletionState") == "deleting"
                or any(
                    item.get("jti") == payload["jti"] and item.get("expiresAt", 0) > time.time()
                    for item in revoked
                )
            ):
                return None
            return public_user(user)

    async def revoke(self, token):
        payload = self.payload(token)
        if payload:

            def update(value):
                entries = [
                    item
                    for item in (value or [])
                    if item.get("expiresAt", 0) > time.time() and item.get("jti") != payload["jti"]
                ]
                return entries + [{"jti": payload["jti"], "expiresAt": payload["exp"]}]

            await self.storage.update(payload["sub"], "revoked-auth-tokens", update)

    def set_cookie(self, response, token):
        response.set_cookie(
            "s2t_auth",
            token,
            max_age=604800,
            httponly=True,
            secure=self.settings.env.get("S2T_COOKIE_SECURE") == "true",
            samesite="none"
            if self.settings.env.get("S2T_COOKIE_SAME_SITE") == "none"
            else "strict",
        )

    def encrypt(self, plaintext):
        key = hashlib.sha256((self.secret + ":s2t-model-credentials:v1").encode()).digest()
        iv = secrets.token_bytes(12)
        encrypted = AESGCM(key).encrypt(iv, plaintext.encode(), None)
        return {
            "v": 1,
            "iv": encode64(iv),
            "tag": encode64(encrypted[-16:]),
            "ciphertext": encode64(encrypted[:-16]),
        }

    def decrypt(self, value):
        if not value:
            return ""
        try:
            key = hashlib.sha256((self.secret + ":s2t-model-credentials:v1").encode()).digest()
            return (
                AESGCM(key)
                .decrypt(
                    decode64(value["iv"]),
                    decode64(value["ciphertext"]) + decode64(value["tag"]),
                    None,
                )
                .decode()
            )
        except Exception:
            fail(503, "已保存的模型 API key 無法解密，請確認 S2T_AUTH_SECRET")
