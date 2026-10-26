from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Segment(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    id: str = Field(min_length=1)
    revision: int = Field(ge=0)
    status: Literal["partial", "final", "gap"]
    startMs: float = Field(ge=0)
    endMs: float = Field(ge=0)
    sourceText: str
    translatedText: str = ""
    speaker: str = ""

    @model_validator(mode="after")
    def time_order(self):
        if self.endMs < self.startMs:
            raise ValueError("endMs must not precede startMs")
        return self


class Session(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True, allow_inf_nan=False)
    id: str = Field(min_length=1)
    title: str
    createdAt: str
    source: str
    transcript: str
    audioKey: str = ""
    durationMs: float = Field(ge=0)
    segments: list[Segment]
    audioVersions: list[dict] = Field(default_factory=list)


class SessionWrite(BaseModel):
    model_config = ConfigDict(strict=True)
    sessions: list[Session]
    version: int = Field(ge=0, le=2**53 - 1)


class RegistryModel(BaseModel):
    model_config = ConfigDict(extra="ignore", strict=True)
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,100}$")
    name: str = Field(max_length=120)
    endpoint: str = Field(max_length=2000)
    model: str = Field(max_length=200)
    purpose: Literal["asr", "translation", "summary", "diarization", "embedding"]
    requiresApiKey: bool = True
    capabilities: dict = Field(default_factory=dict)

    @field_validator("name", "endpoint", "model")
    @classmethod
    def trim_text(cls, value):
        return value.strip()


class RegistryWrite(BaseModel):
    model_config = ConfigDict(strict=True)
    models: list[RegistryModel]
    version: int = Field(ge=0, le=2**53 - 1)

    @field_validator("models")
    @classmethod
    def unique_models(cls, value):
        if len({item.id for item in value}) != len(value):
            raise ValueError("模型 ID 重複")
        return value
