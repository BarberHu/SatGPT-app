"""Single HTTP entry point. Business logic and resources stay in each module."""
from contextlib import AsyncExitStack, asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from basic import server as basic
from harness.app import server as harness


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ExitStack unwinds Basic too if Harness initialization fails.
    async with AsyncExitStack() as stack:
        await stack.enter_async_context(basic.lifespan(app))
        await stack.enter_async_context(harness.lifespan(app))
        yield


app = FastAPI(title="SatGPT API", version="1.0.0", lifespan=lifespan)
app.include_router(basic.router)
app.include_router(harness.router)


def component_status(request: Request) -> dict:
    return {
        "basic": bool(getattr(request.app.state, "basic_initialized", False)),
        "harness": bool(getattr(request.app.state, "harness_initialized", False)
                        and getattr(request.app.state, "controller", None) is not None),
    }


@app.get("/health")
async def health(request: Request):
    # Preserve the legacy Basic fields and the unique Harness fields.
    basic_health, harness_health = await basic.health(), harness.health()
    modules = component_status(request)
    return {
        **harness_health, **basic_health,
        "status": "ok" if all(modules.values()) and basic.gee_service.initialized else "degraded",
        "modules": modules,
        "basic": basic_health, "harness": harness_health,
    }


@app.get("/readyz")
async def readiness(request: Request):
    modules = component_status(request)
    ready = all(modules.values())
    # Readiness measures local lifecycle completion, not model/GEE availability.
    return JSONResponse({"status": "ready" if ready else "degraded", **modules},
                        status_code=200 if ready else 503)
