"""Web router composition. Platform-independent helpers live in http_common."""

from fastapi import APIRouter
from .http_common import (
    TemporaryFileResponse as TemporaryFileResponse,
    user_of as user_of,
    write_upload as write_upload,
)
from .routes.auth import router as auth_router
from .routes.data import router as data_router
from .routes.media import router as media_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(data_router)
router.include_router(media_router)
