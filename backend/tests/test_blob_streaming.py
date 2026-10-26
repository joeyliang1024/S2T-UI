import pytest
import aioboto3
from aiobotocore.stub import AioStubber

from app.core import Settings
from app.storage import Storage


@pytest.mark.asyncio
async def test_s3_multipart_bounded_upload_and_abort(environment):
    settings = Settings(
        {
            **environment,
            "S2T_MINIO_ENDPOINT": "http://not-contacted.invalid",
            "S2T_MINIO_BUCKET": "test",
            "S2T_MINIO_ACCESS_KEY": "test",
            "S2T_MINIO_SECRET_KEY": "test",
        }
    )
    store = Storage(settings)
    first = b"a" * (8 * 1024**2)
    async with aioboto3.Session().client(
        "s3", region_name="us-east-1", aws_access_key_id="test", aws_secret_access_key="test"
    ) as client:
        store.s3 = client
        with AioStubber(client) as stub:
            stub.add_response(
                "create_multipart_upload",
                {"UploadId": "upload-one"},
                {"Bucket": "test", "Key": "alice/audio/one"},
            )
            stub.add_response(
                "upload_part",
                {"ETag": "first"},
                {
                    "Bucket": "test",
                    "Key": "alice/audio/one",
                    "UploadId": "upload-one",
                    "PartNumber": 1,
                    "Body": first,
                },
            )
            stub.add_response(
                "upload_part",
                {"ETag": "last"},
                {
                    "Bucket": "test",
                    "Key": "alice/audio/one",
                    "UploadId": "upload-one",
                    "PartNumber": 2,
                    "Body": b"last",
                },
            )
            stub.add_response(
                "complete_multipart_upload",
                {},
                {
                    "Bucket": "test",
                    "Key": "alice/audio/one",
                    "UploadId": "upload-one",
                    "MultipartUpload": {
                        "Parts": [
                            {"ETag": "first", "PartNumber": 1},
                            {"ETag": "last", "PartNumber": 2},
                        ]
                    },
                },
            )

            async def stream():
                for offset in range(0, len(first), 256 * 1024):
                    yield first[offset : offset + 256 * 1024]
                yield b"last"

            await store.put_stream("alice", "audio/one", stream())
            stub.assert_no_pending_responses()
        with AioStubber(client) as stub:
            stub.add_response(
                "create_multipart_upload",
                {"UploadId": "broken"},
                {"Bucket": "test", "Key": "alice/audio/two"},
            )
            stub.add_response(
                "upload_part",
                {"ETag": "first"},
                {
                    "Bucket": "test",
                    "Key": "alice/audio/two",
                    "UploadId": "broken",
                    "PartNumber": 1,
                    "Body": first,
                },
            )
            stub.add_response(
                "abort_multipart_upload",
                {},
                {"Bucket": "test", "Key": "alice/audio/two", "UploadId": "broken"},
            )

            async def broken():
                yield first
                raise RuntimeError("browser disconnected")

            with pytest.raises(RuntimeError):
                await store.put_stream("alice", "audio/two", broken())
            stub.assert_no_pending_responses()


@pytest.mark.asyncio
async def test_local_failed_upload_preserves_previous_blob(environment):
    store = Storage(Settings(environment))
    await store.open()
    try:
        await store.put_blob("alice", "audio/one", b"original")

        async def broken():
            yield b"partial"
            raise RuntimeError("connection lost")

        with pytest.raises(RuntimeError):
            await store.put_stream("alice", "audio/one", broken())
        assert await store.get_blob("alice", "audio/one") == b"original"
        assert await store.list_blobs("alice") == ["audio/one"]
        from fastapi import HTTPException

        with pytest.raises(HTTPException):
            store.blob_path("alice", "audio/../secret")
    finally:
        await store.close()
