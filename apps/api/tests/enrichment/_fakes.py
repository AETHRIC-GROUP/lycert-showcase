"""Minimal fake Supabase client for enrichment unit tests (no network, no DB).

Supports just the chained query shapes the orchestrator / webhook code uses:
  table(t).select(...).eq(...).maybe_single().execute()
  table(t).insert|update|upsert(payload).eq(...).execute()
plus the audit_logs idempotency lookup (metadata->>enrichment_id).
"""

from typing import Any


class _Result:
    def __init__(self, data: Any) -> None:
        self.data = data
        self.count = len(data) if isinstance(data, list) else None


class _Query:
    def __init__(self, db: "FakeDB", table: str) -> None:
        self.db = db
        self.table_name = table
        self.op = "select"
        self.payload: Any = None
        self.filters: dict[str, Any] = {}
        self.single = False

    # writes
    def insert(self, payload):  self.op = "insert"; self.payload = payload; return self
    def update(self, payload):  self.op = "update"; self.payload = payload; return self
    def upsert(self, payload, on_conflict=None):  self.op = "upsert"; self.payload = payload; return self

    # filters / modifiers (all no-op chainable except eq which we record)
    def select(self, *a, **k): return self
    def eq(self, col, val): self.filters[col] = val; return self
    def in_(self, col, val): return self
    def gte(self, col, val): return self
    def lt(self, col, val): return self
    def order(self, *a, **k): return self
    def limit(self, n): return self
    def is_(self, col, val): return self
    def maybe_single(self): self.single = True; return self

    @property
    def not_(self): return self

    def execute(self):
        return self.db._execute(self)


class FakeDB:
    def __init__(self) -> None:
        self.enrichment_rows: dict[str, dict] = {}   # subscriber_id -> subscriber_enrichment row
        self.subscriber_rows: dict[str, dict] = {}    # id -> subscribers row
        self.stale_pending: list[dict] = []           # rows returned by cleanup select
        self.audit_logs: list[dict] = []
        self.provider_rows: list[dict] = []           # enrichment_providers rows
        self.waterfall_rows: list[dict] = []          # tenant_waterfall_config rows
        self.writes: list[tuple[str, str, Any]] = []  # (table, op, payload)

    def table(self, name: str) -> _Query:
        return _Query(self, name)

    # convenience accessors for assertions
    def writes_to(self, table: str, op: str | None = None) -> list[Any]:
        return [p for (t, o, p) in self.writes if t == table and (op is None or o == op)]

    def _execute(self, q: _Query) -> _Result:
        t, op = q.table_name, q.op
        if op != "select":
            self.writes.append((t, op, q.payload))
            if t == "audit_logs" and op == "insert":
                self.audit_logs.append(q.payload)
            if t == "subscriber_enrichment" and op == "upsert":
                row = dict(q.payload)
                self.enrichment_rows[row["subscriber_id"]] = row
            if t == "subscriber_enrichment" and op == "update":
                sid = q.filters.get("subscriber_id")
                if sid in self.enrichment_rows:
                    self.enrichment_rows[sid].update(q.payload)
            payload = q.payload
            if isinstance(payload, dict):
                d = dict(payload)
                d.setdefault("id", f"{t}-{len(self.writes)}")
                return _Result([d])
            return _Result(payload if isinstance(payload, list) else [payload])

        # selects
        if t == "audit_logs":
            eid = q.filters.get("metadata->>enrichment_id")
            rid = q.filters.get("resource_id")
            action = q.filters.get("action")
            matches = [
                a for a in self.audit_logs
                if a.get("action") == action
                and a.get("resource_id") == rid
                and (a.get("metadata") or {}).get("enrichment_id") == eid
            ]
            return _Result(matches)
        if t == "subscriber_enrichment":
            if q.single:
                return _Result(self.enrichment_rows.get(q.filters.get("subscriber_id")))
            return _Result(list(self.stale_pending))
        if t == "subscribers":
            if q.single:
                return _Result(self.subscriber_rows.get(q.filters.get("id")))
            return _Result(list(self.subscriber_rows.values()))
        if t == "subscriber_scores":
            return _Result(None if q.single else [])
        if t == "enrichment_providers":
            ptype = q.filters.get("provider_type")
            rows = [r for r in self.provider_rows if ptype is None or r.get("provider_type") == ptype]
            return _Result(rows)
        if t == "tenant_waterfall_config":
            return _Result(list(self.waterfall_rows))
        return _Result(None if q.single else [])
