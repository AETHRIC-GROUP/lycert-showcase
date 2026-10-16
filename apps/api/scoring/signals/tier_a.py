"""Tier A signals — billing data (highest weight, hardest to fake)."""
from __future__ import annotations
from datetime import date
from scoring.models import ScoringConfig, SubscriberRecord

Signal = tuple[int, str, str]


def score_a1(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """A1 — Renewal After Graduation.

    Days between graduation and last renewal (negative = renewed after graduating).
    Sub-tier points scale proportionally from config.signal_a1_weight.
    """
    if record.renewal_delta_days is None:
        return 0, "", "data_gap_renewal"

    days = record.renewal_delta_days
    w = config.signal_a1_weight  # max weight (default 35)

    if days < -365:
        return w, "A1_renewed_365d_after_grad", \
               f"Renewed {abs(days)} days after stated graduation date"
    if days < -180:
        pts = round(w * 30 / 35)
        return pts, "A1_renewed_180d_after_grad", \
               f"Renewed {abs(days)} days after stated graduation date"
    if days < -90:
        pts = round(w * 25 / 35)
        return pts, "A1_renewed_90d_after_grad", \
               f"Renewed {abs(days)} days after stated graduation date"
    if days < 0:
        pts = round(w * 15 / 35)
        return pts, "A1_renewed_after_grad", \
               f"Renewed {abs(days)} days after stated graduation date"
    if days <= 90:
        pts = round(w * 5 / 35)
        return pts, "A1_renewed_near_graduation", \
               f"Renewed within {days} days of graduation"
    return 0, "", ""


def score_a2(record: SubscriberRecord, config: ScoringConfig, reference_date: date) -> Signal:
    """A2 — Graduation Date Already Past.

    Compares stated_graduation_date to reference_date (not today — deterministic).
    Sub-tier points scale proportionally from config.signal_a2_weight.
    """
    if record.stated_graduation_date is None:
        return 0, "", "data_gap_graduation"

    delta = (reference_date - record.stated_graduation_date).days
    if delta <= 0:
        return 0, "", ""

    w = config.signal_a2_weight  # max weight (default 20)
    if delta <= 90:
        pts = round(w * 5 / 20)
        return pts, "A2_graduated_recently", \
               f"Graduated {delta} days ago (recently past)"
    if delta <= 180:
        pts = round(w * 10 / 20)
        return pts, "A2_graduated_3_6mo_ago", \
               f"Graduated {delta} days ago (3–6 months)"
    if delta <= 365:
        pts = round(w * 15 / 20)
        return pts, "A2_graduated_6_12mo_ago", \
               f"Graduated {delta} days ago (6–12 months)"
    return w, "A2_graduated_over_1yr_ago", \
           f"Graduated {delta} days ago (over 1 year)"


def score_a3(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """A3 — Proof Submitted Before Subscription Started."""
    if record.proof_submission_date is None or record.subscription_start_date is None:
        return 0, "", ""

    delta = (record.subscription_start_date - record.proof_submission_date).days
    w = config.signal_a3_weight  # max weight (default 20)

    if delta > 30:
        return w, "A3_proof_predates_subscription", \
               f"Proof of enrollment submitted {delta} days before subscription existed"
    if delta >= 0:
        pts = round(w * 5 / 20)
        return pts, "A3_proof_slightly_early", \
               f"Proof of enrollment submitted {delta} days before subscription start"
    return 0, "", ""


def score_a4(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """A4 — Subscription Duration > 730 days."""
    if record.subscription_start_date is None or record.subscription_end_date is None:
        return 0, "", ""

    duration = (record.subscription_end_date - record.subscription_start_date).days
    if duration > 730:
        return config.signal_a4_weight, "A4_subscription_over_2yrs", \
               f"Subscription active for {duration} days (over 2 years)"
    return 0, "", ""
