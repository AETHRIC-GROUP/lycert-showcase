"""Unit tests for the lifecycle stage computation engine.

Each test covers one transition rule from LYCERT_ARCHITECTURE.md §2.3.
All tests use a fixed reference date (2026-06-06) for determinism.
"""

import pytest
from datetime import date
from services.lifecycle import compute_stage

TODAY = date(2026, 6, 6)
GRACE = 90  # default grace period days


# ── Active student (>90 days before graduation) ────────────────────────────

def test_far_future_graduation_is_active_student() -> None:
    grad = date(2027, 1, 1)  # 209 days away
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "active_student"


def test_exactly_91_days_away_is_active_student() -> None:
    grad = TODAY + date.resolution * 91  # 91 days
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "active_student"


# ── Approaching graduation (1–90 days before) ─────────────────────────────

def test_90_days_away_is_approaching_graduation() -> None:
    grad = TODAY + date.resolution * 90
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "approaching_graduation"


def test_1_day_away_is_approaching_graduation() -> None:
    grad = TODAY + date.resolution * 1
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "approaching_graduation"


def test_approaching_graduation_does_not_downgrade_to_active() -> None:
    """A subscriber already in approaching_graduation should stay there until past graduation."""
    grad = TODAY + date.resolution * 45
    assert compute_stage(grad, "approaching_graduation", GRACE, TODAY) == "approaching_graduation"


# ── Grace period (0 to -grace_period_days) ────────────────────────────────

def test_graduation_today_is_still_active_student_grace() -> None:
    grad = TODAY
    assert compute_stage(grad, "approaching_graduation", GRACE, TODAY) == "active_student"


def test_1_day_after_graduation_within_grace_is_active_student() -> None:
    grad = TODAY - date.resolution * 1
    assert compute_stage(grad, "approaching_graduation", GRACE, TODAY) == "active_student"


def test_exactly_grace_period_boundary_is_still_active_student() -> None:
    grad = TODAY - date.resolution * GRACE
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "active_student"


def test_custom_grace_period_respected() -> None:
    grad = TODAY - date.resolution * 30
    assert compute_stage(grad, "active_student", grace_period_days=60, today=TODAY) == "active_student"
    assert compute_stage(grad, "active_student", grace_period_days=29, today=TODAY) == "post_graduation_unverified"


# ── Post-graduation unverified (past grace period) ────────────────────────

def test_one_day_past_grace_is_post_graduation() -> None:
    grad = TODAY - date.resolution * (GRACE + 1)
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "post_graduation_unverified"


def test_long_past_graduation_is_post_graduation() -> None:
    grad = date(2024, 1, 1)
    assert compute_stage(grad, "active_student", GRACE, TODAY) == "post_graduation_unverified"


# ── Locked stages — must never be overridden by date logic ────────────────

def test_converted_stage_never_changes() -> None:
    grad = date(2024, 1, 1)  # well past graduation + grace
    assert compute_stage(grad, "converted", GRACE, TODAY) == "converted"


def test_churned_stage_never_changes() -> None:
    grad = TODAY + date.resolution * 200
    assert compute_stage(grad, "churned", GRACE, TODAY) == "churned"


def test_dismissed_stage_never_changes() -> None:
    grad = TODAY - date.resolution * (GRACE + 100)
    assert compute_stage(grad, "dismissed", GRACE, TODAY) == "dismissed"


def test_re_verification_pending_never_changes() -> None:
    grad = date(2025, 1, 1)
    assert compute_stage(grad, "re_verification_pending", GRACE, TODAY) == "re_verification_pending"


# ── Missing graduation date ────────────────────────────────────────────────

def test_no_graduation_date_returns_current_stage_unchanged() -> None:
    assert compute_stage(None, "active_student", GRACE, TODAY) == "active_student"
    assert compute_stage(None, "post_graduation_unverified", GRACE, TODAY) == "post_graduation_unverified"
