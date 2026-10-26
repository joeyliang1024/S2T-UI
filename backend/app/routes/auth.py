"""Web contracts implemented by Python; no legacy forwarding or Node runtime."""

import re
import time

from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, Response

from ..auth import public_user, username, nt_identity
from ..core import digest, fail, now, read_json, safe

router = APIRouter()

from ..http_common import runtime, user_of


@router.post("/api/auth/register")
async def register(request: Request):
    rt = runtime(request)
    await rt.admission.window(request.client.host if request.client else "unknown", "register", 20)
    data = await read_json(request, 65536)
    data.pop("role", None)
    user = await rt.auth.create(data)
    token = rt.auth.issue(user)
    response = JSONResponse({"user": user, "token": token}, status_code=201)
    rt.auth.set_cookie(response, token)
    return response


@router.post("/api/auth/login")
async def login(request: Request):
    rt = runtime(request)
    data = await read_json(request, 65536)
    name = nt_identity(data["NT"]).lower() if "NT" in data else username(data.get("username"))
    key = "login-failures-" + digest(name)
    value = await rt.storage.get("auth", key) or {}
    if value.get("until", 0) > time.time() and value.get("count", 0) >= 8:
        fail(429, "登入失敗次數過多，請 15 分鐘後再試")
    await rt.admission.window(name, "login-attempts", 30)
    try:
        user = await rt.auth.login(data)
    except Exception:
        await rt.storage.update(
            "auth",
            key,
            lambda value: {
                "count": (value or {}).get("count", 0) + 1
                if (value or {}).get("until", 0) > time.time()
                else 1,
                "until": time.time() + 900,
            },
        )
        raise
    await rt.storage.remove("auth", key)
    token = rt.auth.issue(user)
    response = JSONResponse({"user": user, "token": token})
    rt.auth.set_cookie(response, token)
    return response


@router.get("/api/auth/session")
async def session(request: Request):
    return {"user": await user_of(request)}


@router.post("/api/auth/logout")
async def logout(request: Request):
    token = re.sub(
        r"^Bearer\s+", "", request.headers.get("authorization", ""), flags=re.I
    ) or request.cookies.get("s2t_auth", "")
    await runtime(request).auth.revoke(token)
    response = Response(status_code=204)
    response.delete_cookie("s2t_auth", httponly=True, samesite="strict")
    return response


@router.api_route("/api/admin/users", methods=["GET", "POST"])
async def admin_users(request: Request):
    rt = runtime(request)
    admin = await user_of(request, {"admin"})
    if request.method == "GET":
        return {
            "users": [
                {
                    **public_user(user),
                    "sharingAuthorization": await rt.storage.get(
                        user["id"], "sharing-authorization"
                    )
                    or {"approved": False, "department": ""},
                }
                for user in (await rt.auth.accounts())[:1000]
            ]
        }
    data = await read_json(request, 65536)
    user = await rt.auth.create(data)
    await rt.storage.put(
        user["id"],
        "sharing-authorization",
        {
            "approved": True,
            "department": user["Department"],
            "approvedBy": admin["id"],
            "updatedAt": now(),
        },
    )
    return JSONResponse({"user": user}, status_code=201)


@router.put("/api/admin/users/{user_id}/role")
async def admin_role(user_id: str, request: Request):
    rt = runtime(request)
    admin = await user_of(request, {"admin"})
    data = await read_json(request, 65536)
    if data.get("role") not in {"developer", "user"}:
        fail(400, "只能設定 developer 或 user")
    async with rt.storage.transaction("auth-accounts") as tx:
        actor = await rt.auth.account(user_id=admin["id"], tx=tx)
        user = await rt.auth.account(user_id=safe(user_id), tx=tx)
        if not actor or actor.get("role") != "admin" or actor.get("deletionState") == "deleting":
            fail(403, "管理者帳號已不可用")
        if not user:
            fail(404, "找不到帳號")
        if (
            user.get("role") == "admin"
            or user_id == admin["id"]
            or user.get("deletionState") == "deleting"
        ):
            fail(409, "不能變更此帳號權限")
        user["role"] = data["role"]
        await rt.auth.save_account(tx, user)
    return {"user": public_user(user)}


@router.api_route("/api/admin/users/{user_id}/sharing-authorization", methods=["GET", "PUT"])
async def sharing(user_id: str, request: Request):
    rt = runtime(request)
    admin = await user_of(request, {"admin"})
    async with rt.storage.account_guard(safe(user_id)):
        if request.method == "GET":
            stored = await rt.storage.get(user_id, "sharing-authorization") or {}
            return {
                "authorization": {
                    "approved": stored.get("approved") is True,
                    "department": stored.get("department", ""),
                }
            }
        data = await read_json(request, 65536)
        if (
            type(data.get("approved")) is not bool
            or not isinstance(data.get("department"), str)
            or len(data["department"].strip()) > 256
        ):
            fail(400, "共享授權格式無效")
        value = {"approved": data["approved"], "department": data["department"].strip()}
        await rt.storage.put(
            user_id,
            "sharing-authorization",
            {**value, "approvedBy": admin["id"], "updatedAt": now()},
        )
        return {"authorization": value}


@router.delete("/api/admin/users/{user_id}")
async def delete_account(user_id: str, request: Request):
    rt = runtime(request)
    admin = await user_of(request, {"admin"})
    if user_id == admin["id"]:
        fail(409, "不能刪除目前登入的帳號")
    safe(user_id)
    async with rt.storage.transaction("auth-accounts") as tx:
        user = await rt.auth.account(user_id=user_id, tx=tx)
        if user:
            if user.get("role") == "admin":
                fail(409, "必須保留唯一 admin")
            user["deletionState"] = "deleting"
            await rt.auth.save_account(tx, user)
    async with rt.storage.account_guard(user_id, exclusive=True):
        journal = await rt.storage.get("account-deletions", user_id) or {}
        ids = set(journal.get("vectorIds", []))
        ids.update(item["id"] for item in await rt.storage.get(user_id, "voiceprints") or [])
        ids.update(
            item["id"] for item in await rt.storage.get(user_id, "voiceprint-compensations") or []
        )
        await rt.storage.put("account-deletions", user_id, {"vectorIds": sorted(ids)})
        if (
            user
            and user["username"]
            == rt.settings.env.get("S2T_BOOTSTRAP_ADMIN_USERNAME", "admin").strip().lower()
        ):
            await rt.storage.put("auth", "retired-bootstrap-" + digest(user["username"])[:40], True)
        for key in await rt.storage.list_blobs(user_id):
            await rt.storage.remove_blob(user_id, key)
        for vector_id in ids:
            await rt.voiceprints.vector_remove(user_id, vector_id)
        async with rt.storage.transaction("auth-accounts") as tx:
            if hasattr(tx, "connection"):
                await tx.connection.execute(
                    "DELETE FROM s2t_config_records WHERE scope=%s", (user_id,)
                )
                await tx.connection.execute(
                    "DELETE FROM s2t_users WHERE id=%s AND deletion_state='deleting'", (user_id,)
                )
            else:
                for entry in await tx.list(user_id):
                    await tx.remove(user_id, entry["key"])
                jobs = await tx.get("diarization-system", "jobs") or {"jobs": []}
                await tx.put(
                    "diarization-system",
                    "jobs",
                    {"jobs": [job for job in jobs["jobs"] if job["userId"] != user_id]},
                )
                if user:
                    await tx.remove("auth", "account-" + user["username"])
                    await tx.remove("auth", "nt-" + digest(user["NT"].lower())[:40])
        await rt.storage.remove("account-deletions", user_id)
    return {"deleted": True}
