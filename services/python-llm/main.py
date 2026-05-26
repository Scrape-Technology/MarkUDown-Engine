import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

load_dotenv()
from fastapi.middleware.cors import CORSMiddleware
from routers.extract import router as extract_router
from routers.schema import router as schema_router
from routers.deep_research import router as deep_research_router
from routers.summarize import router as summarize_router
from routers.agent import router as agent_router
from routers.plan import router as plan_router
from routers.discover_selectors import router as discover_selectors_router

INTERNAL_SERVICE_KEY = os.getenv("INTERNAL_SERVICE_KEY", "")


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not os.getenv("GENAI_API_KEY"):
        raise RuntimeError("Required environment variable not set: GENAI_API_KEY")
    if not INTERNAL_SERVICE_KEY:
        raise RuntimeError("Required environment variable not set: INTERNAL_SERVICE_KEY")
    yield


_raw_origins = os.getenv("ALLOWED_ORIGINS", "")
if not _raw_origins:
    raise RuntimeError("Required environment variable not set: ALLOWED_ORIGINS — '*' is not allowed in production")
ALLOWED_ORIGINS = [o.strip() for o in _raw_origins.split(",") if o.strip()]

app = FastAPI(
    title="MarkUDown Python LLM Service",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def require_internal_key(request: Request, call_next):
    """Block all requests that do not carry the correct internal service key.
    /health is exempt so K8s liveness probes still work."""
    if request.url.path == "/health":
        return await call_next(request)
    provided = request.headers.get("X-Internal-Key", "")
    if provided != INTERNAL_SERVICE_KEY:
        return JSONResponse(status_code=403, content={"detail": "Forbidden"})
    return await call_next(request)


app.include_router(extract_router, prefix="/extract", tags=["extract"])
app.include_router(schema_router, prefix="/schema", tags=["schema"])
app.include_router(deep_research_router, prefix="/deep-research", tags=["deep-research"])
app.include_router(summarize_router, prefix="/summarize", tags=["summarize"])
app.include_router(agent_router, prefix="/agent", tags=["agent"])
app.include_router(plan_router, prefix="/plan", tags=["plan"])
app.include_router(discover_selectors_router, prefix="/discover-selectors", tags=["discover-selectors"])


@app.get("/health")
async def health():
    return {"status": "healthy", "service": "python-llm"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "3002"))
    uvicorn.run(app, host="0.0.0.0", port=port)
