/** @type {import('next').NextConfig} */
const config = {
  // Public (browser-safe) settings. Values come from the environment: `.env.local` for local
  // development, Project Settings on Vercel. See `.env.local.example`.
  env: {
    NEXT_PUBLIC_LYCERT_SUPABASE_URL: process.env.NEXT_PUBLIC_LYCERT_SUPABASE_URL,
    NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_LYCERT_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_LYCERT_API_URL: process.env.NEXT_PUBLIC_LYCERT_API_URL,
  },
}

export default config
