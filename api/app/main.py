"""FastAPI application entrypoint for FireTagger."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import settings
from app.db.session import engine
from app.routes import admin, public

logger = logging.getLogger("firetagger.api")


def _error_payload(
    error: str,
    message: str,
    details: dict[str, Any] | list[Any] | None = None,
) -> dict[str, Any]:
    """Build the stable error shape consumed by future bot and API clients."""

    return {"error": error, "message": message, "details": details}


def _database_status() -> str:
    """Return the current database status after a lightweight connectivity check."""

    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return "unavailable"
    return "ok"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Run process startup checks before serving requests."""

    app.state.database_status = "not_checked"
    if settings.database_startup_check:
        app.state.database_status = _database_status()
        if app.state.database_status != "ok":
            logger.error(
                "Database startup check failed; future Discord bot should forward this to #tagger-logs."
            )
            raise RuntimeError("Database startup check failed")
        logger.info("Database startup check passed.")
    yield


def create_app() -> FastAPI:
    """Create and configure the FireTagger API application."""

    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        lifespan=lifespan,
    )

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-API-Key"],
        )

    app.include_router(public.router)
    app.include_router(admin.router)

    @app.get("/health", tags=["health"])
    def health() -> JSONResponse:
        """Return service health and database connectivity for orchestration probes."""

        database_status = _database_status()
        status_code = (
            status.HTTP_200_OK
            if database_status == "ok"
            else status.HTTP_503_SERVICE_UNAVAILABLE
        )
        return JSONResponse(
            status_code=status_code,
            content={
                "status": "ok" if database_status == "ok" else "degraded",
                "database": database_status,
                "environment": settings.environment,
            },
        )

    @app.exception_handler(HTTPException)
    async def http_exception_handler(
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        """Normalize HTTP exceptions without hiding their status codes."""

        if isinstance(exc.detail, dict) and {"error", "message", "details"}.issubset(
            exc.detail.keys()
        ):
            payload = exc.detail
        else:
            payload = _error_payload(
                "http_error",
                str(exc.detail) if exc.detail else "Request failed.",
            )
        return JSONResponse(
            status_code=exc.status_code,
            content=payload,
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """Return validation errors in the same stable envelope as API errors."""

        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            content=_error_payload(
                "validation_error",
                "Request validation failed.",
                {"errors": exc.errors()},
            ),
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        """Log unhandled failures for future forwarding to #tagger-logs."""

        logger.exception(
            "Unhandled API error on %s %s; future Discord bot should forward this to #tagger-logs.",
            request.method,
            request.url.path,
        )
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_payload(
                "internal_server_error",
                "An unexpected API error occurred.",
            ),
        )

    return app


app = create_app()
