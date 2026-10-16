-- 0045_verification_sub_processors.sql
-- GDPR Records of Processing (Art.30) for the VERIFICATION layer (LYCERT_VERIFICATION_ARCHITECTURE.md
-- + LYCERT_DOCUMENT_REVIEW_ARCHITECTURE.md Part 5.7): every vendor the verification waterfall could send
-- personal data to gets a registry row NOW, seeded active=false. `active` flips only when the DPA/SCC
-- (and for the document path, the DPIA) is on file — the same gate pattern as the enrichment providers.
--
-- Notes:
--  - Anthropic PBC already has a row for case-explanation generation (0013). Document-review OCR is a
--    DIFFERENT processing purpose on more sensitive data (uploaded enrollment documents), so it gets its
--    own row — Art.30 records are per-purpose.
--  - Resend already has a row (0013, 'Transactional email delivery', inactive) that covers the
--    email-loop verification links; no duplicate is added here.
-- Applies to BOTH staging and prod (depends only on sub_processor_registry, 0013).

INSERT INTO sub_processor_registry
  (name, purpose, data_categories, country, transfer_mechanism, active) VALUES
  ('Anthropic PBC', 'Vision OCR of subscriber-uploaded enrollment documents (verification Step 5 — classify + minimal-field extraction; process-and-purge, no training on data)',
   'Enrollment document image (transient), name, institution, enrollment status/dates',
   'United States', 'Standard Contractual Clauses (SCCs)', false),
  ('National Student Clearinghouse', 'Authoritative US enrollment verification (verification waterfall — pending commercial agreement)',
   'Name, date of birth, institution, enrollment status',
   'United States', 'Standard Contractual Clauses (SCCs)', false),
  ('Jisc Services Ltd (HEDD)', 'Authoritative UK enrollment/award verification (verification waterfall — pending agreement)',
   'Name, institution, enrollment/award status',
   'United Kingdom', 'UK adequacy decision', false)
ON CONFLICT DO NOTHING;
