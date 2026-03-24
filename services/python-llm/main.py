import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers.extract import router as extract_router
from routers.schema import router as schema_router
from routers.deep_research import router as deep_research_router
from routers.summarize import router as summarize_router
from routers.agent import router as agent_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.getenv("GENAI_API_KEY"):
        raise RuntimeError("Required environment variable not set: GENAI_API_KEY")
    yield


_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()] or ["*"]

app = FastAPI(title="MarkUDown Python LLM Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(extract_router, prefix="/extract", tags=["extract"])
app.include_router(schema_router, prefix="/schema", tags=["schema"])
app.include_router(deep_research_router, prefix="/deep-research", tags=["deep-research"])
app.include_router(summarize_router, prefix="/summarize", tags=["summarize"])
app.include_router(agent_router, prefix="/agent", tags=["agent"])


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "python-llm"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "3002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
