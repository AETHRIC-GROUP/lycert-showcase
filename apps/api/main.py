import os
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from routers import health, auth, subscribers, scores, cases, lifecycle, enrich

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pre-warm the JWKS cache so the first authenticated request doesn't pay a blocking
    # HTTP fetch on the critical path. Failure is non-fatal — auth will retry per request.
    try:
        from middleware.auth import _get_jwks
        await _get_jwks()
        logger.info("JWKS pre-warmed at startup")
    except Exception as exc:
        logger.warning("JWKS pre-warm failed (non-fatal): %s", exc)
    yield


app = FastAPI(title="Lycert API", version="1.0.0", lifespan=lifespan)

allowed_origins = os.getenv("LYCERT_ALLOWED_ORIGINS", "http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in allowed_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router,      prefix="/api/v1")
app.include_router(auth.router,        prefix="/api/v1")
app.include_router(subscribers.router, prefix="/api/v1")
app.include_router(scores.router,      prefix="/api/v1")
app.include_router(cases.router,       prefix="/api/v1")
app.include_router(lifecycle.router,   prefix="/api/v1")
app.include_router(enrich.router,      prefix="/api/v1")
