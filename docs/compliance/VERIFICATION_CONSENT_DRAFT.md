# Enrollment Verification — Consent Text DRAFT (for legal review)
**Status:** ⚠️ DRAFT — NOT legally reviewed. Replaces the placeholder `consent_text_version` used in
the verification foundation. **Do not run any `requires_consent` provider against this text until
counsel signs off** (`LYCERT_VERIFICATION_ARCHITECTURE.md` Part 9.1.2; `NEXT_STEPS.md` step 8).
**Created:** 2026-06-28
**For counsel:** see §4 "Questions for legal" — please confirm FERPA sufficiency + GDPR Art. 6/9 basis.

---

## 0. Why this exists
NSC (and other authoritative sources) will **not** return a student's enrollment record to a third
party without the student's **signed, dated consent** that is **scoped, purpose-stated, and
recipient-identified**. Absent valid consent, NSC returns "Unable to Confirm." FERPA makes this
non-negotiable. The hosted re-verification flow must capture all five elements and store the exact
consent text version. (Part 3.1, Part 6.1.)

## 1. The five FERPA fields → where each is captured
These map 1:1 to the `verification_consents` table columns built in migration `0038`.

| FERPA element | Table column | Value in this draft |
|---|---|---|
| **What records** (scope) | `scope` | `enrollment_status` (current enrollment only — not transcripts/grades) |
| **Purpose** | `purpose` | continued EDU-eligibility verification for `{client_name}` |
| **Recipient** | `recipient` | `National Student Clearinghouse` (and/or the named institution) |
| **Signed & dated** | `granted_at` + electronic signature capture | timestamp + checkbox/typed-name affirmation, IP in `ip_address` |
| **Version** | `consent_text_version` | the version id of the text below (e.g. `ferpa-v1-2026-06`) |

Also stored: `granted_via='hosted_verification_flow'`, `expires_at` (consent is time-bounded),
`revoked_at` (consent is revocable — Part 6.1).

---

## 2. Consent screen — proposed copy

> ### Confirm your student status
>
> **{client_name}** offers special student pricing for {product_name}. To keep your student pricing,
> we need to confirm that you are **currently enrolled** at your school. Lycert performs this check on
> behalf of {client_name}.
>
> By checking the box below, you authorize the following:
>
> - **What will be checked:** your **current enrollment status** at your educational institution
>   (whether you are currently enrolled, and your enrollment dates). *We do not request or receive your
>   grades, transcripts, courses, or any other academic records.*
> - **Who will check it:** Lycert (operated by Aethric Group LLC), acting for **{client_name}**, by
>   sending a verification request to the **National Student Clearinghouse** and/or your educational
>   institution.
> - **Why:** solely to confirm your continued eligibility for {client_name}'s student program.
> - **What we keep:** only the **result** (enrolled / not enrolled / unable to confirm) and the date it
>   was confirmed. We do **not** store your underlying education records. The result is deleted after
>   the eligibility decision and any appeal period.
> - **Your rights:** this authorization is voluntary and you may **withdraw it at any time** by
>   contacting {client_name} or {support_email}. Withdrawing it will not retroactively undo a check
>   already completed, but no further checks will run. This authorization expires on **{expiry_date}**.
>
> [ ] **I authorize this enrollment verification.** I confirm I am the person named below.
>
> Full name: `________________`  (typed name = electronic signature)
> Date: `{auto-filled today}`
>
> [ Confirm and continue ]   [ Cancel ]

*(Variables in `{…}` are filled at render time. The exact rendered text + its `consent_text_version`
are stored so we can always reproduce what a given subscriber agreed to.)*

---

## 3. GDPR layer (for EU subscribers)
- **Lawful basis for verification processing: the subscriber's consent** (GDPR Art. 6(1)(a)) — this is
  cleaner than the legitimate-interest basis used for enrichment, and it is the basis to document in
  the LIA/ROPA for the verification layer specifically.
- Education records may be **special-category or otherwise sensitive** in some jurisdictions; the
  explicit-consent basis (Art. 9(2)(a)) is intended to cover this. **Counsel to confirm** whether
  enrollment *status* (vs full records) rises to special-category in the relevant member states.
- Consent must be as easy to withdraw as to give (Art. 7(3)) — the withdrawal path above satisfies the
  product side; counsel to confirm wording.
- Data minimisation (Art. 5(1)(c)) is enforced in code: only the result is stored, never the payload.

---

## 4. Questions for legal
1. Does the §2 text satisfy **FERPA** as a valid third-party consent (signed, dated, scoped, purpose,
   recipient)? Any mandatory wording NSC specifically requires? *(Confirm against NSC — see
   `docs/NSC_PROCUREMENT.md` §3 Q5.)*
2. **GDPR basis:** is Art. 6(1)(a) consent + Art. 9(2)(a) explicit consent the right pairing, and does
   enrollment *status* count as special-category in our target EU markets (notably Germany/Germany)?
3. Is the **controller/processor split** stated correctly (client = controller of the compliance
   decision; Lycert = processor running the check)? Does this belong in the consent text or only the DPA?
4. **Retention:** is 90 days (decision + appeal window) defensible, or should it differ by jurisdiction?
5. **Revocation wording** — is "withdrawing won't undo a completed check" acceptable and clearly worded?
6. Do we need **separate consent versions** per provider (NSC vs institution-direct vs email-loop), or
   does one scoped text cover all authoritative methods?

---

## 5. After sign-off (engineering)
- Set the approved text as a new `consent_text_version` (e.g. `ferpa-v1-2026-06`) in the hosted flow.
- Build the consent-capture UI in the hosted re-verification flow (step 8) writing all five fields.
- Only then enable any `requires_consent` provider for live checks (NSC = step 9).
