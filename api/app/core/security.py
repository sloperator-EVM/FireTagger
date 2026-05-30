"""Security dependencies for protected API routes."""

from __future__ import annotations

from collections import defaultdict, deque
from collections.abc import Callable
from secrets import compare_digest
from time import monotonic
from typing import Final

from fastapi import Header, HTTPException, Request, status

from app.core.config import settings

ADMIN_RATE_LIMIT: Final[tuple[int, int]] = (10, 60)
_rate_limit_windows: dict[str, deque[float]] = defaultdict(deque)


def require_admin_api_key(x_api_key: str = Header(default="", alias="X-API-Key")) -> str:
    """Require the configured admin API key before allowing admin mutations."""

    if not settings.api_key or not compare_digest(x_api_key.encode(), settings.api_key.encode()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={
                "error": "invalid_api_key",
                "message": "A valid admin API key is required.",
                "details": None,
            },
        )
    return x_api_key


def _client_host(request: Request) -> str:
    """Return the caller host, honoring a proxy-provided forwarding header."""

    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",", maxsplit=1)[0].strip()
    if request.client is not None:
        return request.client.host
    return "unknown"


def admin_rate_limiter(
    max_requests: int = ADMIN_RATE_LIMIT[0],
    window_seconds: int = ADMIN_RATE_LIMIT[1],
) -> Callable[[Request, str], None]:
    """Create an in-process sliding-window rate limiter for admin routes."""

    def dependency(
        request: Request,
        api_key: str = Header(default="", alias="X-API-Key"),
    ) -> None:
        now = monotonic()
        key_fragment = api_key or _client_host(request)
        key = f"admin:{key_fragment}:{_client_host(request)}"
        request_times = _rate_limit_windows[key]

        while request_times and now - request_times[0] >= window_seconds:
            request_times.popleft()

        if len(request_times) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - request_times[0])))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail={
                    "error": "rate_limited",
                    "message": "Too many admin requests. Please retry later.",
                    "details": {
                        "limit": max_requests,
                        "window_seconds": window_seconds,
                        "retry_after_seconds": retry_after,
                    },
                },
                headers={"Retry-After": str(retry_after)},
            )

        request_times.append(now)

    return dependency
