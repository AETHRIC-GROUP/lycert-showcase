from __future__ import annotations
from pydantic import BaseModel
from datetime import date
from typing import Optional


STRONG_PROFESSIONAL_KEYWORDS: list[str] = [
    "ceo", "founder", "co-founder", "director", "vp", "vice president",
    "president", "principal", "partner", "head of", "chief", "owner",
    "freelance", "self-employed", "senior", "lead", "manager",
    "architect", "interior designer", "landscape architect", "archviz",
    "architectural visualization", "3d visualizer", "visualization artist",
    "rendering artist", "3d artist", "cg artist", "cgi artist", "bim",
]

WEAK_PROFESSIONAL_KEYWORDS: list[str] = [
    "analyst", "associate", "coordinator", "specialist", "technician",
    "engineer", "developer", "designer", "consultant",
]

AEC_PROFESSIONAL_KEYWORDS: list[str] = [
    "architect", "interior designer", "landscape architect", "archviz",
    "architectural visualization", "3d visualizer", "visualization artist",
    "rendering artist", "3d artist", "cg artist", "cgi artist", "bim",
]

STUDENT_KEYWORDS: list[str] = [
    "student", "intern", "trainee", "apprentice", "phd", "ph.d",
    "doctoral", "researcher", "graduate student", "msc", "bsc",
    "bachelor", "master",
]

PERSONAL_DOMAINS: set[str] = {
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com",
    "icloud.com", "protonmail.com", "mail.com", "me.com", "googlemail.com",
    "yahoo.co.uk", "hotmail.co.uk", "msn.com", "aol.com", "ymail.com",
    "wp.pl", "naver.com",
}

ACADEMIC_INDICATORS: list[str] = [".edu", ".ac.", "university", ".uni.", "student."]
ACADEMIC_COMPANY_INDICATORS: list[str] = [".edu", ".ac.", "university", "school", "college", "institute"]

COUNTRY_ALIASES: dict[str, str] = {
    "usa": "united states",
    "us": "united states",
    "united states of america": "united states",
    "uk": "united kingdom",
    "great britain": "united kingdom",
    "england": "united kingdom",
    "uae": "united arab emirates",
    "south korea": "korea",
    "republic of korea": "korea",
    "the former yugoslav republic of": "north macedonia",
    "macedonia": "north macedonia",
    "czech republic": "czechia",
}


class ScoringConfig(BaseModel):
    """Per-tenant configurable scoring parameters. Defaults match CEDS baseline."""
    tier1_threshold: int = 65
    tier2_threshold: int = 40
    tier3_threshold: int = 20
    grace_period_days: int = 90

    signal_a1_weight: int = 35
    signal_a2_weight: int = 20
    signal_a3_weight: int = 20
    signal_a4_weight: int = 10

    signal_b1_personal_weight: int = 8
    signal_b2_weight: int = 20
    signal_b3_weight: int = 8

    signal_c1_weight: int = 25
    signal_c2_strong_weight: int = 20
    signal_c2_weak_weight: int = 10
    signal_c3_weight: int = 15
    signal_c4_weight: int = 10

    signal_b1_academic_exculpatory: int = -10
    signal_c2_student_exculpatory: int = -15
    signal_c3_future_exculpatory: int = -5
    signal_c4_academic_exculpatory: int = -5

    vertical_tag: str = "aec"

    # Keyword lists — override per vertical
    strong_professional_keywords: list[str] = STRONG_PROFESSIONAL_KEYWORDS
    weak_professional_keywords: list[str] = WEAK_PROFESSIONAL_KEYWORDS
    aec_professional_keywords: list[str] = AEC_PROFESSIONAL_KEYWORDS
    student_keywords: list[str] = STUDENT_KEYWORDS


class SubscriberRecord(BaseModel):
    """Canonical subscriber fields after field mapping. All optional except email."""
    email: str = ""
    account_name: str = ""
    institution_name: str = ""
    institution_location: str = ""
    account_country: str = ""
    # PDL Location-Cleaner normalised countries (preferred by B3 when present; raw+alias fallback).
    institution_country_normalized: str = ""
    account_country_normalized: str = ""
    stated_graduation_date: Optional[date] = None
    renewal_delta_days: Optional[int] = None
    proof_submission_date: Optional[date] = None
    subscription_start_date: Optional[date] = None
    subscription_end_date: Optional[date] = None

    # LinkedIn enrichment
    li_current_employer_name: str = ""
    li_job_end_date: Optional[date] = None   # None = currently employed
    li_job_title: str = ""
    li_education_end_date: Optional[date] = None
    li_current_employer_domain: str = ""


class ScoreResult(BaseModel):
    """Output of the scoring engine for one subscriber."""
    total_score: int
    confidence_tier: int                  # 0 = clean, 1 = near-certain, 2 = high, 3 = watch
    tier_label: str
    data_confidence: str                  # 'high' | 'medium' | 'low'
    primary_signal: str
    supporting_signals: str               # pipe-separated descriptions
    signals_count: int
    signals_fired: str                    # comma-separated signal keys
    data_gaps: str                        # comma-separated gap names
    aec_professional_confirmed: bool
    recommended_action: str
    scoring_version: str = "1.0.0"
