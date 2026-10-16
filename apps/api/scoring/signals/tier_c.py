"""Tier C signals — LinkedIn enrichment data (only scored when data is present)."""
from __future__ import annotations
from datetime import date
from scoring.models import (
    ScoringConfig, SubscriberRecord,
    ACADEMIC_COMPANY_INDICATORS,
)

Signal = tuple[int, str, str]


def score_c1(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """C1 — Currently Employed on LinkedIn.

    Company present + no end date → currently employed (strong signal).
    Company present + end date exists → previously employed (soft signal).
    """
    if not record.li_current_employer_name:
        return 0, "", ""
    if record.li_job_end_date is None:
        return config.signal_c1_weight, "C1_currently_employed", \
               f"Currently employed full-time at {record.li_current_employer_name} on LinkedIn"
    pts = round(config.signal_c1_weight * 5 / 25)
    return pts, "C1_previously_employed", \
           f"Previously employed at {record.li_current_employer_name} on LinkedIn"


def score_c2(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """C2 — LinkedIn Title Keywords (two-tier: strong / weak, student takes priority).

    Student keywords checked first — if matched, returns exculpatory score and stops.
    Then strong professional keywords (config.signal_c2_strong_weight).
    Then weak professional keywords (config.signal_c2_weak_weight).
    """
    title = record.li_job_title.strip().lower()
    if not title:
        return 0, "", ""

    for kw in config.student_keywords:
        if kw in title:
            return config.signal_c2_student_exculpatory, "C2_student_title_exculpatory", \
                   f"LinkedIn title suggests current student ('{record.li_job_title}')"
    for kw in config.strong_professional_keywords:
        if kw in title:
            return config.signal_c2_strong_weight, "C2_professional_title_strong", \
                   f"LinkedIn title indicates professional role ('{record.li_job_title}')"
    for kw in config.weak_professional_keywords:
        if kw in title:
            return config.signal_c2_weak_weight, "C2_professional_title_weak", \
                   f"LinkedIn title indicates professional role ('{record.li_job_title}')"
    return 0, "", ""


def score_c3(record: SubscriberRecord, config: ScoringConfig, reference_date: date) -> Signal:
    """C3 — LinkedIn Education End Year relative to reference_date.year."""
    if record.li_education_end_date is None:
        return 0, "", ""

    year = record.li_education_end_date.year
    this_year = reference_date.year
    w = config.signal_c3_weight  # max weight (default 15)

    if year < this_year - 1:
        return w, "C3_education_ended", \
               f"LinkedIn education ended in {year}"
    if year == this_year - 1:
        pts = round(w * 10 / 15)
        return pts, "C3_education_ended_last_year", \
               f"LinkedIn education ended in {year}"
    if year == this_year:
        return 0, "", ""
    # year > this_year
    return config.signal_c3_future_exculpatory, "C3_future_graduation_exculpatory", \
           f"LinkedIn shows future graduation year ({year})"


def score_c4(record: SubscriberRecord, config: ScoringConfig) -> Signal:
    """C4 — Employer Domain (academic = exculpatory, commercial = suspicious)."""
    domain = record.li_current_employer_domain.strip().lower()
    if not domain:
        return 0, "", ""

    for indicator in ACADEMIC_COMPANY_INDICATORS:
        if indicator in domain:
            return config.signal_c4_academic_exculpatory, "C4_academic_employer_exculpatory", \
                   f"Employer domain suggests academic institution ({domain})"
    return config.signal_c4_weight, "C4_commercial_employer", \
           f"Employer has a commercial domain ({domain})"
