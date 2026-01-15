from pydantic import BaseModel, Field, HttpUrl
from typing import Optional, List, Dict, Any
from enum import Enum
from uuid import UUID, uuid4
from datetime import datetime

class JobStatus(str, Enum):
    PENDING = "pending"       # Na fila
    PROCESSING = "processing" # Worker pegou
    COMPLETED = "completed"   # Sucesso
    FAILED = "failed"         # Erro em todas as tentativas

class ScrapeFormat(str, Enum):
    MARKDOWN = "markdown"
    HTML = "html"
    JSON = "json"
    CLEAN_TEXT = "text"

class ScrapeOptions(BaseModel):
    """Opções para guiar o Intelligent Fallback e formatação"""
    formats: List[ScrapeFormat] = [ScrapeFormat.MARKDOWN]
    wait_for_selector: Optional[str] = None
    headers: Optional[Dict[str, str]] = None
    timeout: int = 60 # segundos
    # Se True, força o uso direto do Abrasio/Stealth sem tentar o método rápido antes
    force_stealth: bool = False 

class JobPayload(BaseModel):
    """O pacote de dados que viaja pelo Redis"""
    id: str = Field(default_factory=lambda: str(uuid4()))
    url: str
    options: ScrapeOptions = Field(default_factory=ScrapeOptions)
    status: JobStatus = JobStatus.PENDING
    created_at: datetime = Field(default_factory=datetime.utcnow)
    
    # Campos preenchidos após o processamento
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    attempts_made: int = 0
    processing_time_ms: float = 0.0

    class Config:
        json_encoders = {
            datetime: lambda v: v.isoformat()
        }