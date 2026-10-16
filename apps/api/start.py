"""Railway startup wrapper.

Reads PORT from environment directly (bypasses shell $PORT expansion issues)
and logs any startup errors to stdout so they appear in Railway deployment logs.
"""
import os
import sys


def main() -> None:
    port = int(os.environ.get("PORT", "8000"))
    host = os.environ.get("HOST", "0.0.0.0")

    print(f"[start] Python {sys.version}", flush=True)
    print(f"[start] PORT={port} HOST={host}", flush=True)
    print(f"[start] CWD={os.getcwd()}", flush=True)
    print(f"[start] sys.path={sys.path[:3]}", flush=True)

    try:
        import main as app_module  # noqa: F401 — validates all imports succeed
        print("[start] main module imported OK", flush=True)
    except Exception as exc:
        print(f"[start] IMPORT ERROR: {exc}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)

    import uvicorn
    try:
        uvicorn.run("main:app", host=host, port=port, log_level="info")
    except Exception as exc:
        print(f"[start] UVICORN CRASHED: {exc}", flush=True)
        import traceback
        traceback.print_exc()
        sys.exit(1)
    # Uvicorn exited cleanly (SIGTERM from Railway rolling deploy) — exit 0 is correct here
    print("[start] uvicorn exited cleanly", flush=True)


if __name__ == "__main__":
    main()
