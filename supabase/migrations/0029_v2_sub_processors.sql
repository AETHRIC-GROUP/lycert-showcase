-- 0029_v2_sub_processors.sql
-- LYCERT_WATERFALL_ENRICHMENT_V2.md Part 7. Register the V2 waterfall providers as
-- sub-processors (GDPR Art. 28). Inserted as active=false: a provider goes live only once
-- its DPA/SCC documentation is collected, the API key is configured, and the Privacy Policy
-- sub-processor list is updated. Flip active=true (and set dpa_signed_at / dpa_document_url)
-- per provider at that point.
--
-- The shift to predominantly French/EU providers materially improves our cross-border
-- transfer posture vs the previous US-only (PDL/Apollo) stack — note in the next LIA revision.

INSERT INTO sub_processor_registry
  (name, purpose, data_categories, country, transfer_mechanism, active) VALUES
  ('ZeroBounce (Hertza, LLC)', 'Email deliverability validation (Stage 0 gate)',
   'Email address',
   'United States', 'Standard Contractual Clauses (SCCs)', false),
  ('Hunter (Hunter SAS)', 'Professional email enrichment (waterfall step 1)',
   'Email address, name, employment data, LinkedIn handle, country',
   'France', 'EU/EEA — no third-country transfer', false),
  ('ReverseContact (Visum SAS)', 'Personal-email → LinkedIn profile enrichment (waterfall step 2)',
   'Email address, name, LinkedIn profile, employment history, education history, location',
   'France', 'EU/EEA — no third-country transfer', false),
  ('Datagma (Datagma SAS)', 'Real-time person enrichment (waterfall step 3)',
   'Email address, name, LinkedIn profile, employment history, education history, location',
   'France', 'EU/EEA — no third-country transfer (real-time retrieval, no stored database)', false),
  ('FullEnrich (FullEnrich SAS)', 'Async waterfall-of-waterfalls final sweep (waterfall step 5)',
   'Email address, name, LinkedIn profile, employment data, location',
   'France', 'EU/EEA — no third-country transfer (SOC 2 Type II; GDPR/CCPA per their docs)', false),
  ('People Data Labs, Inc.', 'Person + company enrichment (waterfall step 4)',
   'Email address, name, LinkedIn profile, employment history, education history, location, skills',
   'United States', 'Standard Contractual Clauses (SCCs)', false);
