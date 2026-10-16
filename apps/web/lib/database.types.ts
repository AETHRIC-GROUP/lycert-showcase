export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      academic_domains: {
        Row: {
          country: string | null
          created_at: string
          domain: string
          name: string
          source: string
        }
        Insert: {
          country?: string | null
          created_at?: string
          domain: string
          name: string
          source?: string
        }
        Update: {
          country?: string | null
          created_at?: string
          domain?: string
          name?: string
          source?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          actor_id: string | null
          actor_type: Database["public"]["Enums"]["actor_type"]
          created_at: string
          id: string
          ip_address: string | null
          metadata: Json | null
          resource_id: string | null
          resource_type: string
          tenant_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          resource_id?: string | null
          resource_type: string
          tenant_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_type?: Database["public"]["Enums"]["actor_type"]
          created_at?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          resource_id?: string | null
          resource_type?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      case_comments: {
        Row: {
          author_id: string
          body: string
          case_id: string
          created_at: string
          id: string
          tenant_id: string
        }
        Insert: {
          author_id: string
          body: string
          case_id: string
          created_at?: string
          id?: string
          tenant_id: string
        }
        Update: {
          author_id?: string
          body?: string
          case_id?: string
          created_at?: string
          id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "case_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_comments_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "case_comments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      cases: {
        Row: {
          assigned_to: string | null
          closed_at: string | null
          decided_at: string | null
          decided_by: string | null
          decision: Database["public"]["Enums"]["case_decision"]
          decision_note: string | null
          id: string
          opened_at: string
          review_duration_seconds: number | null
          reviewed_at: string | null
          score_id: string
          status: Database["public"]["Enums"]["case_status"]
          subscriber_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          closed_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["case_decision"]
          decision_note?: string | null
          id?: string
          opened_at?: string
          review_duration_seconds?: number | null
          reviewed_at?: string | null
          score_id: string
          status?: Database["public"]["Enums"]["case_status"]
          subscriber_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          closed_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          decision?: Database["public"]["Enums"]["case_decision"]
          decision_note?: string | null
          id?: string
          opened_at?: string
          review_duration_seconds?: number | null
          reviewed_at?: string | null
          score_id?: string
          status?: Database["public"]["Enums"]["case_status"]
          subscriber_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cases_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_score_id_fkey"
            columns: ["score_id"]
            isOneToOne: false
            referencedRelation: "subscriber_scores"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_jobs: {
        Row: {
          apollo_credits_consumed: number
          async_pending_count: number
          completed_at: string | null
          created_at: string
          error_count: number
          error_message: string | null
          estimated_cost_usd: number | null
          id: string
          job_type: string
          low_quality_count: number
          miss_count: number
          pdl_credits_consumed: number
          per_provider_stats: Json | null
          processed_count: number
          started_at: string | null
          status: string
          subscriber_ids: Json | null
          success_count: number
          tenant_id: string
          total_count: number | null
          trigger_reason: string | null
        }
        Insert: {
          apollo_credits_consumed?: number
          async_pending_count?: number
          completed_at?: string | null
          created_at?: string
          error_count?: number
          error_message?: string | null
          estimated_cost_usd?: number | null
          id?: string
          job_type: string
          low_quality_count?: number
          miss_count?: number
          pdl_credits_consumed?: number
          per_provider_stats?: Json | null
          processed_count?: number
          started_at?: string | null
          status?: string
          subscriber_ids?: Json | null
          success_count?: number
          tenant_id: string
          total_count?: number | null
          trigger_reason?: string | null
        }
        Update: {
          apollo_credits_consumed?: number
          async_pending_count?: number
          completed_at?: string | null
          created_at?: string
          error_count?: number
          error_message?: string | null
          estimated_cost_usd?: number | null
          id?: string
          job_type?: string
          low_quality_count?: number
          miss_count?: number
          pdl_credits_consumed?: number
          per_provider_stats?: Json | null
          processed_count?: number
          started_at?: string | null
          status?: string
          subscriber_ids?: Json | null
          success_count?: number
          tenant_id?: string
          total_count?: number | null
          trigger_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "enrichment_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      enrichment_providers: {
        Row: {
          cost_per_success_usd: number | null
          created_at: string
          default_position: number | null
          display_name: string
          enabled: boolean
          execution_mode: string
          id: string
          min_priority: number
          notes: string | null
          provider_key: string
          provider_type: string
          requires_name_company: boolean
          returns_education: boolean
          returns_employment_dates: boolean
          trust_rank: number
          updated_at: string
        }
        Insert: {
          cost_per_success_usd?: number | null
          created_at?: string
          default_position?: number | null
          display_name: string
          enabled?: boolean
          execution_mode: string
          id?: string
          min_priority?: number
          notes?: string | null
          provider_key: string
          provider_type: string
          requires_name_company?: boolean
          returns_education?: boolean
          returns_employment_dates?: boolean
          trust_rank?: number
          updated_at?: string
        }
        Update: {
          cost_per_success_usd?: number | null
          created_at?: string
          default_position?: number | null
          display_name?: string
          enabled?: boolean
          execution_mode?: string
          id?: string
          min_priority?: number
          notes?: string | null
          provider_key?: string
          provider_type?: string
          requires_name_company?: boolean
          returns_education?: boolean
          returns_employment_dates?: boolean
          trust_rank?: number
          updated_at?: string
        }
        Relationships: []
      }
      institutions: {
        Row: {
          abuse_flag_count: number
          accreditation_status: string | null
          country: string | null
          created_at: string
          degree_granting: boolean
          domain: string | null
          hesa_id: string | null
          id: string
          institution_type: Database["public"]["Enums"]["institution_type"]
          ipeds_id: string | null
          name: string
          source: string
          trust_tier: Database["public"]["Enums"]["trust_tier"]
          updated_at: string
        }
        Insert: {
          abuse_flag_count?: number
          accreditation_status?: string | null
          country?: string | null
          created_at?: string
          degree_granting?: boolean
          domain?: string | null
          hesa_id?: string | null
          id?: string
          institution_type?: Database["public"]["Enums"]["institution_type"]
          ipeds_id?: string | null
          name: string
          source?: string
          trust_tier?: Database["public"]["Enums"]["trust_tier"]
          updated_at?: string
        }
        Update: {
          abuse_flag_count?: number
          accreditation_status?: string | null
          country?: string | null
          created_at?: string
          degree_granting?: boolean
          domain?: string | null
          hesa_id?: string | null
          id?: string
          institution_type?: Database["public"]["Enums"]["institution_type"]
          ipeds_id?: string | null
          name?: string
          source?: string
          trust_tier?: Database["public"]["Enums"]["trust_tier"]
          updated_at?: string
        }
        Relationships: []
      }
      integrations: {
        Row: {
          config: Json | null
          created_at: string
          credentials_encrypted: string | null
          error_message: string | null
          id: string
          integration_type: Database["public"]["Enums"]["integration_type"]
          last_sync_at: string | null
          status: Database["public"]["Enums"]["integration_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          config?: Json | null
          created_at?: string
          credentials_encrypted?: string | null
          error_message?: string | null
          id?: string
          integration_type: Database["public"]["Enums"]["integration_type"]
          last_sync_at?: string | null
          status?: Database["public"]["Enums"]["integration_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          config?: Json | null
          created_at?: string
          credentials_encrypted?: string | null
          error_message?: string | null
          id?: string
          integration_type?: Database["public"]["Enums"]["integration_type"]
          last_sync_at?: string | null
          status?: Database["public"]["Enums"]["integration_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "integrations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      sub_processor_registry: {
        Row: {
          active: boolean
          country: string
          created_at: string
          data_categories: string
          dpa_document_url: string | null
          dpa_signed_at: string | null
          id: string
          name: string
          purpose: string
          transfer_mechanism: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          country: string
          created_at?: string
          data_categories: string
          dpa_document_url?: string | null
          dpa_signed_at?: string | null
          id?: string
          name: string
          purpose: string
          transfer_mechanism?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          country?: string
          created_at?: string
          data_categories?: string
          dpa_document_url?: string | null
          dpa_signed_at?: string | null
          id?: string
          name?: string
          purpose?: string
          transfer_mechanism?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      subscriber_employer_enrichment: {
        Row: {
          delete_at: string
          employer_founded_year: number | null
          employer_headcount: number | null
          employer_industry: string | null
          employer_name_canonical: string | null
          employer_pdl_id: string | null
          employer_size_band: string | null
          employer_total_funding: number | null
          enriched_at: string
          id: string
          subscriber_id: string
          tenant_id: string
        }
        Insert: {
          delete_at: string
          employer_founded_year?: number | null
          employer_headcount?: number | null
          employer_industry?: string | null
          employer_name_canonical?: string | null
          employer_pdl_id?: string | null
          employer_size_band?: string | null
          employer_total_funding?: number | null
          enriched_at?: string
          id?: string
          subscriber_id: string
          tenant_id: string
        }
        Update: {
          delete_at?: string
          employer_founded_year?: number | null
          employer_headcount?: number | null
          employer_industry?: string | null
          employer_name_canonical?: string | null
          employer_pdl_id?: string | null
          employer_size_band?: string | null
          employer_total_funding?: number | null
          enriched_at?: string
          id?: string
          subscriber_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriber_employer_enrichment_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: true
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriber_employer_enrichment_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriber_enrichment: {
        Row: {
          async_next_poll_at: string | null
          async_poll_count: number
          async_provider_mode: string | null
          async_reference: string | null
          async_submitted_at: string | null
          completeness: string | null
          delete_at: string
          enriched_at: string
          enrichment_provider: Database["public"]["Enums"]["enrichment_provider"]
          field_provenance: Json | null
          id: string
          li_city: string | null
          li_country: string | null
          li_current_employer_domain: string | null
          li_current_employer_linkedin_url: string | null
          li_current_employer_name: string | null
          li_education_end_date: string | null
          li_education_institution: string | null
          li_employer_industry: string | null
          li_employer_size: string | null
          li_job_end_date: string | null
          li_job_start_date: string | null
          li_job_title: string | null
          li_job_title_levels: Json | null
          li_skills: Json | null
          li_state: string | null
          linkedin_profile_url: string | null
          pdl_likelihood_score: number | null
          pdl_person_id: string | null
          pending_async_provider: string | null
          provider_miss_reason: string | null
          providers_attempted: Json | null
          subscriber_id: string
          tenant_id: string
        }
        Insert: {
          async_next_poll_at?: string | null
          async_poll_count?: number
          async_provider_mode?: string | null
          async_reference?: string | null
          async_submitted_at?: string | null
          completeness?: string | null
          delete_at: string
          enriched_at?: string
          enrichment_provider: Database["public"]["Enums"]["enrichment_provider"]
          field_provenance?: Json | null
          id?: string
          li_city?: string | null
          li_country?: string | null
          li_current_employer_domain?: string | null
          li_current_employer_linkedin_url?: string | null
          li_current_employer_name?: string | null
          li_education_end_date?: string | null
          li_education_institution?: string | null
          li_employer_industry?: string | null
          li_employer_size?: string | null
          li_job_end_date?: string | null
          li_job_start_date?: string | null
          li_job_title?: string | null
          li_job_title_levels?: Json | null
          li_skills?: Json | null
          li_state?: string | null
          linkedin_profile_url?: string | null
          pdl_likelihood_score?: number | null
          pdl_person_id?: string | null
          pending_async_provider?: string | null
          provider_miss_reason?: string | null
          providers_attempted?: Json | null
          subscriber_id: string
          tenant_id: string
        }
        Update: {
          async_next_poll_at?: string | null
          async_poll_count?: number
          async_provider_mode?: string | null
          async_reference?: string | null
          async_submitted_at?: string | null
          completeness?: string | null
          delete_at?: string
          enriched_at?: string
          enrichment_provider?: Database["public"]["Enums"]["enrichment_provider"]
          field_provenance?: Json | null
          id?: string
          li_city?: string | null
          li_country?: string | null
          li_current_employer_domain?: string | null
          li_current_employer_linkedin_url?: string | null
          li_current_employer_name?: string | null
          li_education_end_date?: string | null
          li_education_institution?: string | null
          li_employer_industry?: string | null
          li_employer_size?: string | null
          li_job_end_date?: string | null
          li_job_start_date?: string | null
          li_job_title?: string | null
          li_job_title_levels?: Json | null
          li_skills?: Json | null
          li_state?: string | null
          linkedin_profile_url?: string | null
          pdl_likelihood_score?: number | null
          pdl_person_id?: string | null
          pending_async_provider?: string | null
          provider_miss_reason?: string | null
          providers_attempted?: Json | null
          subscriber_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriber_enrichment_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: true
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriber_enrichment_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscriber_scores: {
        Row: {
          aec_professional_confirmed: boolean
          ai_explanation: string | null
          confidence_tier: number
          data_confidence: Database["public"]["Enums"]["data_confidence_level"]
          data_gaps: string | null
          id: string
          primary_signal: string | null
          recommended_action: string
          scored_at: string
          scoring_version: string
          signals_count: number
          signals_fired: string | null
          subscriber_id: string
          supporting_signals: string | null
          tenant_id: string
          tier_label: string
          total_score: number
        }
        Insert: {
          aec_professional_confirmed?: boolean
          ai_explanation?: string | null
          confidence_tier: number
          data_confidence: Database["public"]["Enums"]["data_confidence_level"]
          data_gaps?: string | null
          id?: string
          primary_signal?: string | null
          recommended_action: string
          scored_at?: string
          scoring_version?: string
          signals_count?: number
          signals_fired?: string | null
          subscriber_id: string
          supporting_signals?: string | null
          tenant_id: string
          tier_label: string
          total_score: number
        }
        Update: {
          aec_professional_confirmed?: boolean
          ai_explanation?: string | null
          confidence_tier?: number
          data_confidence?: Database["public"]["Enums"]["data_confidence_level"]
          data_gaps?: string | null
          id?: string
          primary_signal?: string | null
          recommended_action?: string
          scored_at?: string
          scoring_version?: string
          signals_count?: number
          signals_fired?: string | null
          subscriber_id?: string
          supporting_signals?: string | null
          tenant_id?: string
          tier_label?: string
          total_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "subscriber_scores_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriber_scores_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      subscribers: {
        Row: {
          account_country: string | null
          account_country_normalized: string | null
          account_name: string | null
          auto_renew: boolean
          created_at: string
          days_before_last_renewal: number | null
          deleted_at: string | null
          deleted_by: string | null
          email: string
          email_domain_type: string | null
          email_typo_suggestion: string | null
          email_validated_at: string | null
          email_validation_status: string | null
          enrichment_deferred: boolean | null
          enrichment_priority: number | null
          enrichment_provider:
            | Database["public"]["Enums"]["enrichment_provider"]
            | null
          external_id: string | null
          id: string
          institution_country_normalized: string | null
          institution_domain_verified: string | null
          institution_location: string | null
          institution_name: string | null
          institution_name_normalized: string | null
          institution_pdl_verified: boolean | null
          institution_trust_tier: string | null
          last_enriched_at: string | null
          last_scored_at: string | null
          lifecycle_stage: Database["public"]["Enums"]["lifecycle_stage"]
          name: string | null
          plan_name: string | null
          plan_type: Database["public"]["Enums"]["plan_type"]
          renewal_date: string | null
          stated_graduation_date: string | null
          subscription_end_date: string | null
          subscription_start_date: string | null
          tenant_id: string
          updated_at: string
          verification_confidence: string | null
          verification_expires_at: string | null
          verification_method: string | null
          verification_status: string | null
          verified_at: string | null
        }
        Insert: {
          account_country?: string | null
          account_country_normalized?: string | null
          account_name?: string | null
          auto_renew?: boolean
          created_at?: string
          days_before_last_renewal?: number | null
          deleted_at?: string | null
          deleted_by?: string | null
          email: string
          email_domain_type?: string | null
          email_typo_suggestion?: string | null
          email_validated_at?: string | null
          email_validation_status?: string | null
          enrichment_deferred?: boolean | null
          enrichment_priority?: number | null
          enrichment_provider?:
            | Database["public"]["Enums"]["enrichment_provider"]
            | null
          external_id?: string | null
          id?: string
          institution_country_normalized?: string | null
          institution_domain_verified?: string | null
          institution_location?: string | null
          institution_name?: string | null
          institution_name_normalized?: string | null
          institution_pdl_verified?: boolean | null
          institution_trust_tier?: string | null
          last_enriched_at?: string | null
          last_scored_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"]
          name?: string | null
          plan_name?: string | null
          plan_type?: Database["public"]["Enums"]["plan_type"]
          renewal_date?: string | null
          stated_graduation_date?: string | null
          subscription_end_date?: string | null
          subscription_start_date?: string | null
          tenant_id: string
          updated_at?: string
          verification_confidence?: string | null
          verification_expires_at?: string | null
          verification_method?: string | null
          verification_status?: string | null
          verified_at?: string | null
        }
        Update: {
          account_country?: string | null
          account_country_normalized?: string | null
          account_name?: string | null
          auto_renew?: boolean
          created_at?: string
          days_before_last_renewal?: number | null
          deleted_at?: string | null
          deleted_by?: string | null
          email?: string
          email_domain_type?: string | null
          email_typo_suggestion?: string | null
          email_validated_at?: string | null
          email_validation_status?: string | null
          enrichment_deferred?: boolean | null
          enrichment_priority?: number | null
          enrichment_provider?:
            | Database["public"]["Enums"]["enrichment_provider"]
            | null
          external_id?: string | null
          id?: string
          institution_country_normalized?: string | null
          institution_domain_verified?: string | null
          institution_location?: string | null
          institution_name?: string | null
          institution_name_normalized?: string | null
          institution_pdl_verified?: boolean | null
          institution_trust_tier?: string | null
          last_enriched_at?: string | null
          last_scored_at?: string | null
          lifecycle_stage?: Database["public"]["Enums"]["lifecycle_stage"]
          name?: string | null
          plan_name?: string | null
          plan_type?: Database["public"]["Enums"]["plan_type"]
          renewal_date?: string | null
          stated_graduation_date?: string | null
          subscription_end_date?: string | null
          subscription_start_date?: string | null
          tenant_id?: string
          updated_at?: string
          verification_confidence?: string | null
          verification_expires_at?: string | null
          verification_method?: string | null
          verification_status?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "subscribers_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_brand_config: {
        Row: {
          approved_at: string | null
          created_at: string
          email_footer_text: string | null
          font_family: string | null
          id: string
          logo_url: string | null
          primary_color: string | null
          reply_to_email: string | null
          secondary_color: string | null
          sender_email: string | null
          sender_name: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          created_at?: string
          email_footer_text?: string | null
          font_family?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string | null
          reply_to_email?: string | null
          secondary_color?: string | null
          sender_email?: string | null
          sender_name?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          created_at?: string
          email_footer_text?: string | null
          font_family?: string | null
          id?: string
          logo_url?: string | null
          primary_color?: string | null
          reply_to_email?: string | null
          secondary_color?: string | null
          sender_email?: string | null
          sender_name?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_brand_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_field_mappings: {
        Row: {
          calculation_formula: string | null
          canonical_field: string
          client_field_name: string | null
          created_at: string
          id: string
          notes: string | null
          source_fields: string[] | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          calculation_formula?: string | null
          canonical_field: string
          client_field_name?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          source_fields?: string[] | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          calculation_formula?: string | null
          canonical_field?: string
          client_field_name?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          source_fields?: string[] | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_field_mappings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_scoring_config: {
        Row: {
          enrichment_auto_trigger: boolean
          grace_period_days: number
          id: string
          monthly_enrichment_budget: number | null
          signal_a1_weight: number
          signal_a2_weight: number
          signal_a3_weight: number
          signal_a4_weight: number
          signal_b1_academic_exculpatory: number
          signal_b1_personal_weight: number
          signal_b2_weight: number
          signal_b3_weight: number
          signal_c1_weight: number
          signal_c2_strong_weight: number
          signal_c2_student_exculpatory: number
          signal_c2_weak_weight: number
          signal_c3_future_exculpatory: number
          signal_c3_weight: number
          signal_c4_academic_exculpatory: number
          signal_c4_weight: number
          tenant_id: string
          tier1_threshold: number
          tier2_threshold: number
          tier3_threshold: number
          updated_at: string
          vertical_tag: string
        }
        Insert: {
          enrichment_auto_trigger?: boolean
          grace_period_days?: number
          id?: string
          monthly_enrichment_budget?: number | null
          signal_a1_weight?: number
          signal_a2_weight?: number
          signal_a3_weight?: number
          signal_a4_weight?: number
          signal_b1_academic_exculpatory?: number
          signal_b1_personal_weight?: number
          signal_b2_weight?: number
          signal_b3_weight?: number
          signal_c1_weight?: number
          signal_c2_strong_weight?: number
          signal_c2_student_exculpatory?: number
          signal_c2_weak_weight?: number
          signal_c3_future_exculpatory?: number
          signal_c3_weight?: number
          signal_c4_academic_exculpatory?: number
          signal_c4_weight?: number
          tenant_id: string
          tier1_threshold?: number
          tier2_threshold?: number
          tier3_threshold?: number
          updated_at?: string
          vertical_tag?: string
        }
        Update: {
          enrichment_auto_trigger?: boolean
          grace_period_days?: number
          id?: string
          monthly_enrichment_budget?: number | null
          signal_a1_weight?: number
          signal_a2_weight?: number
          signal_a3_weight?: number
          signal_a4_weight?: number
          signal_b1_academic_exculpatory?: number
          signal_b1_personal_weight?: number
          signal_b2_weight?: number
          signal_b3_weight?: number
          signal_c1_weight?: number
          signal_c2_strong_weight?: number
          signal_c2_student_exculpatory?: number
          signal_c2_weak_weight?: number
          signal_c3_future_exculpatory?: number
          signal_c3_weight?: number
          signal_c4_academic_exculpatory?: number
          signal_c4_weight?: number
          tenant_id?: string
          tier1_threshold?: number
          tier2_threshold?: number
          tier3_threshold?: number
          updated_at?: string
          vertical_tag?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_scoring_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_users: {
        Row: {
          accepted_at: string | null
          display_name: string | null
          email: string
          id: string
          invited_at: string
          role: Database["public"]["Enums"]["user_role"]
          tenant_id: string
          user_id: string
        }
        Insert: {
          accepted_at?: string | null
          display_name?: string | null
          email: string
          id?: string
          invited_at?: string
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id: string
          user_id: string
        }
        Update: {
          accepted_at?: string | null
          display_name?: string | null
          email?: string
          id?: string
          invited_at?: string
          role?: Database["public"]["Enums"]["user_role"]
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_users_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_waterfall_config: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          position: number
          provider_key: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          position: number
          provider_key: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          position?: number
          provider_key?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_waterfall_config_provider_key_fkey"
            columns: ["provider_key"]
            isOneToOne: false
            referencedRelation: "enrichment_providers"
            referencedColumns: ["provider_key"]
          },
          {
            foreignKeyName: "tenant_waterfall_config_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          billing_cycle_start: string | null
          created_at: string
          dpa_signed_at: string | null
          dpa_signed_by: string | null
          enrichment_credits_limit: number | null
          enrichment_credits_used: number
          fcra_review_completed: boolean
          id: string
          name: string
          onboarding_complete: boolean
          plan_tier: Database["public"]["Enums"]["plan_tier"]
          slug: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          stripe_subscription_status: string | null
          updated_at: string
        }
        Insert: {
          billing_cycle_start?: string | null
          created_at?: string
          dpa_signed_at?: string | null
          dpa_signed_by?: string | null
          enrichment_credits_limit?: number | null
          enrichment_credits_used?: number
          fcra_review_completed?: boolean
          id?: string
          name: string
          onboarding_complete?: boolean
          plan_tier?: Database["public"]["Enums"]["plan_tier"]
          slug: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_status?: string | null
          updated_at?: string
        }
        Update: {
          billing_cycle_start?: string | null
          created_at?: string
          dpa_signed_at?: string | null
          dpa_signed_by?: string | null
          enrichment_credits_limit?: number | null
          enrichment_credits_used?: number
          fcra_review_completed?: boolean
          id?: string
          name?: string
          onboarding_complete?: boolean
          plan_tier?: Database["public"]["Enums"]["plan_tier"]
          slug?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          stripe_subscription_status?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      verification_challenges: {
        Row: {
          consumed_at: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          issued_at: string
          outcome: string | null
          subscriber_id: string
          tenant_id: string
          token: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          email: string
          expires_at: string
          id?: string
          issued_at?: string
          outcome?: string | null
          subscriber_id: string
          tenant_id: string
          token: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          issued_at?: string
          outcome?: string | null
          subscriber_id?: string
          tenant_id?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_challenges_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_challenges_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_consents: {
        Row: {
          consent_text_version: string
          created_at: string
          expires_at: string | null
          granted_at: string
          granted_via: string | null
          id: string
          ip_address: string | null
          purpose: string
          recipient: string
          revoked_at: string | null
          scope: string
          subscriber_id: string
          tenant_id: string
        }
        Insert: {
          consent_text_version: string
          created_at?: string
          expires_at?: string | null
          granted_at: string
          granted_via?: string | null
          id?: string
          ip_address?: string | null
          purpose: string
          recipient: string
          revoked_at?: string | null
          scope: string
          subscriber_id: string
          tenant_id: string
        }
        Update: {
          consent_text_version?: string
          created_at?: string
          expires_at?: string | null
          granted_at?: string
          granted_via?: string | null
          id?: string
          ip_address?: string | null
          purpose?: string
          recipient?: string
          revoked_at?: string | null
          scope?: string
          subscriber_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_consents_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_consents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_documents: {
        Row: {
          age_eligible: boolean | null
          confidence: string
          consent_id: string
          created_at: string
          doc_type: string | null
          extracted_doc_issue_date: string | null
          extracted_enrollment_end: string | null
          extracted_enrollment_status: string | null
          extracted_institution: string | null
          extracted_name: string | null
          flag_color_inconsistency: boolean
          flag_composite: boolean
          flag_copy_move: boolean
          flag_font_anomaly: boolean
          flag_metadata_anomaly: boolean
          flag_repeat_document: boolean
          flag_template_deviation: boolean
          id: string
          issuer_country: string | null
          issuer_institution: string | null
          machine_recommendation: string | null
          perceptual_hash: string | null
          physical_security_uncheckable: boolean
          purged_at: string | null
          review_status: string
          reviewer_decided_at: string | null
          reviewer_decision: string | null
          reviewer_id: string | null
          storage_delete_at: string
          subscriber_id: string
          tamper_risk_score: number | null
          tenant_id: string
          transient_storage_ref: string | null
          xref_dates_consistent: boolean | null
          xref_institution_matches_claim: boolean | null
          xref_institution_real: boolean | null
          xref_name_matches_claim: boolean | null
        }
        Insert: {
          age_eligible?: boolean | null
          confidence?: string
          consent_id: string
          created_at?: string
          doc_type?: string | null
          extracted_doc_issue_date?: string | null
          extracted_enrollment_end?: string | null
          extracted_enrollment_status?: string | null
          extracted_institution?: string | null
          extracted_name?: string | null
          flag_color_inconsistency?: boolean
          flag_composite?: boolean
          flag_copy_move?: boolean
          flag_font_anomaly?: boolean
          flag_metadata_anomaly?: boolean
          flag_repeat_document?: boolean
          flag_template_deviation?: boolean
          id?: string
          issuer_country?: string | null
          issuer_institution?: string | null
          machine_recommendation?: string | null
          perceptual_hash?: string | null
          physical_security_uncheckable?: boolean
          purged_at?: string | null
          review_status?: string
          reviewer_decided_at?: string | null
          reviewer_decision?: string | null
          reviewer_id?: string | null
          storage_delete_at: string
          subscriber_id: string
          tamper_risk_score?: number | null
          tenant_id: string
          transient_storage_ref?: string | null
          xref_dates_consistent?: boolean | null
          xref_institution_matches_claim?: boolean | null
          xref_institution_real?: boolean | null
          xref_name_matches_claim?: boolean | null
        }
        Update: {
          age_eligible?: boolean | null
          confidence?: string
          consent_id?: string
          created_at?: string
          doc_type?: string | null
          extracted_doc_issue_date?: string | null
          extracted_enrollment_end?: string | null
          extracted_enrollment_status?: string | null
          extracted_institution?: string | null
          extracted_name?: string | null
          flag_color_inconsistency?: boolean
          flag_composite?: boolean
          flag_copy_move?: boolean
          flag_font_anomaly?: boolean
          flag_metadata_anomaly?: boolean
          flag_repeat_document?: boolean
          flag_template_deviation?: boolean
          id?: string
          issuer_country?: string | null
          issuer_institution?: string | null
          machine_recommendation?: string | null
          perceptual_hash?: string | null
          physical_security_uncheckable?: boolean
          purged_at?: string | null
          review_status?: string
          reviewer_decided_at?: string | null
          reviewer_decision?: string | null
          reviewer_id?: string | null
          storage_delete_at?: string
          subscriber_id?: string
          tamper_risk_score?: number | null
          tenant_id?: string
          transient_storage_ref?: string | null
          xref_dates_consistent?: boolean | null
          xref_institution_matches_claim?: boolean | null
          xref_institution_real?: boolean | null
          xref_name_matches_claim?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "verification_documents_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "verification_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_documents_reviewer_id_fkey"
            columns: ["reviewer_id"]
            isOneToOne: false
            referencedRelation: "tenant_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_documents_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      verification_providers: {
        Row: {
          can_assert_not_enrolled: boolean
          cost_per_check_usd: number | null
          country_scope: string[] | null
          created_at: string
          default_position: number | null
          display_name: string
          enabled: boolean
          id: string
          method_class: string
          notes: string | null
          provider_key: string
          requires_consent: boolean
          updated_at: string
        }
        Insert: {
          can_assert_not_enrolled?: boolean
          cost_per_check_usd?: number | null
          country_scope?: string[] | null
          created_at?: string
          default_position?: number | null
          display_name: string
          enabled?: boolean
          id?: string
          method_class: string
          notes?: string | null
          provider_key: string
          requires_consent?: boolean
          updated_at?: string
        }
        Update: {
          can_assert_not_enrolled?: boolean
          cost_per_check_usd?: number | null
          country_scope?: string[] | null
          created_at?: string
          default_position?: number | null
          display_name?: string
          enabled?: boolean
          id?: string
          method_class?: string
          notes?: string | null
          provider_key?: string
          requires_consent?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      verification_results: {
        Row: {
          as_of_date: string | null
          checked_at: string
          confidence: string
          consent_id: string | null
          delete_at: string | null
          enrollment_end_date: string | null
          enrollment_status: string | null
          id: string
          method_class: string
          provider_key: string
          raw_reference: string | null
          status: string
          subscriber_id: string
          tenant_id: string
        }
        Insert: {
          as_of_date?: string | null
          checked_at?: string
          confidence: string
          consent_id?: string | null
          delete_at?: string | null
          enrollment_end_date?: string | null
          enrollment_status?: string | null
          id?: string
          method_class: string
          provider_key: string
          raw_reference?: string | null
          status: string
          subscriber_id: string
          tenant_id: string
        }
        Update: {
          as_of_date?: string | null
          checked_at?: string
          confidence?: string
          consent_id?: string | null
          delete_at?: string | null
          enrollment_end_date?: string | null
          enrollment_status?: string | null
          id?: string
          method_class?: string
          provider_key?: string
          raw_reference?: string | null
          status?: string
          subscriber_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "verification_results_consent_id_fkey"
            columns: ["consent_id"]
            isOneToOne: false
            referencedRelation: "verification_consents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_results_provider_key_fkey"
            columns: ["provider_key"]
            isOneToOne: false
            referencedRelation: "verification_providers"
            referencedColumns: ["provider_key"]
          },
          {
            foreignKeyName: "verification_results_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "verification_results_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      custom_access_token_hook: { Args: { event: Json }; Returns: Json }
      q_archive: {
        Args: { p_msg_id: number; p_queue: string }
        Returns: boolean
      }
      q_delete: {
        Args: { p_msg_id: number; p_queue: string }
        Returns: boolean
      }
      q_job_accumulate: {
        Args: {
          p_async_pending?: number
          p_cost?: number
          p_error?: number
          p_job_id: string
          p_low_quality?: number
          p_miss?: number
          p_pdl_credits?: number
          p_processed?: number
          p_stats?: Json
          p_success?: number
        }
        Returns: undefined
      }
      q_metrics: {
        Args: never
        Returns: {
          queue_length: number
          queue_name: string
        }[]
      }
      q_read: {
        Args: { p_qty: number; p_queue: string; p_vt: number }
        Returns: {
          enqueued_at: string
          message: Json
          msg_id: number
          read_ct: number
          vt: string
        }[]
      }
      q_send: { Args: { p_msgs: Json; p_queue: string }; Returns: number[] }
      q_to_dlq: {
        Args: { p_dlq: string; p_from: string; p_msg: Json; p_msg_id: number }
        Returns: number
      }
    }
    Enums: {
      actor_type: "user" | "system" | "api"
      case_decision:
        | "proceed_outreach"
        | "dismiss_false_positive"
        | "escalate"
        | "pending"
      case_status:
        | "pending_review"
        | "in_review"
        | "approved_for_outreach"
        | "dismissed"
        | "resolved"
      data_confidence_level: "high" | "medium" | "low"
      enrichment_provider:
        | "clay"
        | "pdl"
        | "apollo"
        | "zerobounce"
        | "hunter"
        | "reversecontact"
        | "datagma"
        | "fullenrich"
        | "pdl_identify"
      institution_type:
        | "research_university"
        | "teaching_university"
        | "community_college"
        | "vocational"
        | "bootcamp"
        | "private_academy"
        | "online_only"
        | "unknown"
      integration_status: "connected" | "disconnected" | "error"
      integration_type:
        | "clay"
        | "pdl"
        | "apollo"
        | "hubspot"
        | "salesforce"
        | "slack"
        | "teams"
        | "jira"
        | "stripe"
        | "zuora"
        | "chargebee"
      lifecycle_stage:
        | "active_student"
        | "approaching_graduation"
        | "post_graduation_unverified"
        | "re_verification_pending"
        | "converted"
        | "churned"
        | "flagged_review"
        | "dismissed"
      plan_tier: "starter" | "growth" | "pro" | "enterprise"
      plan_type: "edu" | "nonprofit" | "startup" | "government"
      trust_tier: "high" | "medium" | "low" | "suspicious"
      user_role: "owner" | "admin" | "manager" | "reviewer" | "viewer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      actor_type: ["user", "system", "api"],
      case_decision: [
        "proceed_outreach",
        "dismiss_false_positive",
        "escalate",
        "pending",
      ],
      case_status: [
        "pending_review",
        "in_review",
        "approved_for_outreach",
        "dismissed",
        "resolved",
      ],
      data_confidence_level: ["high", "medium", "low"],
      enrichment_provider: [
        "clay",
        "pdl",
        "apollo",
        "zerobounce",
        "hunter",
        "reversecontact",
        "datagma",
        "fullenrich",
        "pdl_identify",
      ],
      institution_type: [
        "research_university",
        "teaching_university",
        "community_college",
        "vocational",
        "bootcamp",
        "private_academy",
        "online_only",
        "unknown",
      ],
      integration_status: ["connected", "disconnected", "error"],
      integration_type: [
        "clay",
        "pdl",
        "apollo",
        "hubspot",
        "salesforce",
        "slack",
        "teams",
        "jira",
        "stripe",
        "zuora",
        "chargebee",
      ],
      lifecycle_stage: [
        "active_student",
        "approaching_graduation",
        "post_graduation_unverified",
        "re_verification_pending",
        "converted",
        "churned",
        "flagged_review",
        "dismissed",
      ],
      plan_tier: ["starter", "growth", "pro", "enterprise"],
      plan_type: ["edu", "nonprofit", "startup", "government"],
      trust_tier: ["high", "medium", "low", "suspicious"],
      user_role: ["owner", "admin", "manager", "reviewer", "viewer"],
    },
  },
} as const
