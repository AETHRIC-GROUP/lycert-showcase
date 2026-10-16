-- 0018_pre_enrichment_columns.sql
-- Adds pre-enrichment columns to subscribers table.
-- These are populated by free PDL APIs (School Cleaner, Location Cleaner)
-- at CSV import time — no credits consumed.

ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS institution_name_normalized text;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS institution_domain_verified text;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS institution_country_normalized text;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS institution_pdl_verified boolean DEFAULT false;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS institution_trust_tier text;
-- 'high' / 'medium' / 'low' / 'suspicious' / null

ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS account_country_normalized text;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS email_domain_type text;
-- 'academic' / 'personal' / 'corporate' / 'disposable'

ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS enrichment_priority integer DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS enrichment_deferred boolean DEFAULT false;
