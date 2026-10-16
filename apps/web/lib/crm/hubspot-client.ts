/**
 * Thin fetch wrappers over the HubSpot APIs M1 needs. Endpoints verified against live HubSpot docs
 * 2026-10-09 (DECISIONS.md) — not invented, per Bridge Part 13. Uses the date-based token endpoint
 * (`/oauth/2026-03/token`), not the deprecating legacy `/oauth/v1/token` (resolves Bridge 6.3's
 * "[VERIFY v1 vs v3 token endpoint at build]").
 */

const AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize'
const TOKEN_URL = 'https://api.hubapi.com/oauth/2026-03/token'
const API_BASE = 'https://api.hubapi.com'

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number // seconds
}

function parseTokenResponse(body: Record<string, unknown>): TokenResponse {
  return {
    accessToken: String(body.access_token ?? ''),
    refreshToken: String(body.refresh_token ?? ''),
    expiresIn: Number(body.expires_in ?? 0),
  }
}

/** Authorization URL for Bridge 6.3 step 2. Scopes space-joined then URL-encoded per HubSpot's format. */
export function buildAuthorizeUrl(opts: {
  clientId: string; redirectUri: string; scopes: string[]; state: string
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: opts.scopes.join(' '),
    state: opts.state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

async function postToken(form: Record<string, string>): Promise<TokenResponse> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!resp.ok) throw new Error(`hubspot token exchange ${resp.status}: ${await resp.text()}`)
  return parseTokenResponse(await resp.json())
}

export function exchangeCodeForToken(opts: {
  clientId: string; clientSecret: string; redirectUri: string; code: string
}): Promise<TokenResponse> {
  return postToken({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code: opts.code,
  })
}

export function refreshAccessToken(opts: {
  clientId: string; clientSecret: string; refreshToken: string
}): Promise<TokenResponse> {
  return postToken({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
  })
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

/** GET /crm/v3/properties/{objectType}/{name} — null on 404 (property doesn't exist yet). */
export async function getProperty(
  objectType: string, name: string, accessToken: string,
): Promise<{ name: string; type: string } | null> {
  const resp = await fetch(`${API_BASE}/crm/v3/properties/${objectType}/${encodeURIComponent(name)}`, {
    headers: authHeaders(accessToken),
  })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`hubspot getProperty ${name} ${resp.status}: ${await resp.text()}`)
  const body = await resp.json()
  return { name: body.name, type: body.type }
}

/** POST /crm/v3/properties/{objectType}/groups — idempotent-ish: 409 on "already exists" is swallowed. */
export async function createPropertyGroup(
  objectType: string, group: { name: string; label: string }, accessToken: string,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/crm/v3/properties/${objectType}/groups`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(group),
  })
  if (resp.ok || resp.status === 409) return
  throw new Error(`hubspot createPropertyGroup ${resp.status}: ${await resp.text()}`)
}

export interface CreatePropertyBody {
  groupName: string; name: string; label: string; type: string; fieldType: string
  options?: Array<{ label: string; value: string }>
}

/** POST /crm/v3/properties/{objectType}. 409 (already exists, e.g. a concurrent bootstrap run) is swallowed. */
export async function createProperty(
  objectType: string, body: CreatePropertyBody, accessToken: string,
): Promise<void> {
  const resp = await fetch(`${API_BASE}/crm/v3/properties/${objectType}`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify(body),
  })
  if (resp.ok || resp.status === 409) return
  throw new Error(`hubspot createProperty ${body.name} ${resp.status}: ${await resp.text()}`)
}

export interface SearchFilter { propertyName: string; operator: string; value: string }
export interface SearchResult { id: string; properties: Record<string, string | null> }
export interface SearchResponse { results: SearchResult[]; after: string | null }

/**
 * POST /crm/v3/objects/contacts/search. limit max 200 (verified 2026-10-09 — NOT the common-knowledge
 * 100; Bridge 6.6's "200 per page" was correct). Cursor pagination via paging.next.after.
 */
export async function searchContacts(opts: {
  accessToken: string; filters: SearchFilter[]; properties: string[]; limit: number; after?: string
}): Promise<SearchResponse> {
  const body: Record<string, unknown> = {
    filterGroups: [{ filters: opts.filters }],
    properties: opts.properties,
    limit: opts.limit,
  }
  if (opts.after) body.after = opts.after
  const resp = await fetch(`${API_BASE}/crm/v3/objects/contacts/search`, {
    method: 'POST', headers: authHeaders(opts.accessToken), body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`hubspot searchContacts ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  return {
    results: (data.results ?? []).map((r: { id: string; properties: Record<string, string | null> }) => ({
      id: r.id, properties: r.properties ?? {},
    })),
    after: data.paging?.next?.after ?? null,
  }
}

/** GET /crm/v3/objects/contacts/{id} — null on 404 (deleted/merged-away between the webhook and this call). */
export async function getContact(
  accessToken: string, crmObjectId: string, properties: string[],
): Promise<{ id: string; properties: Record<string, string | null> } | null> {
  const qs = new URLSearchParams({ properties: properties.join(',') })
  const resp = await fetch(`${API_BASE}/crm/v3/objects/contacts/${crmObjectId}?${qs.toString()}`, {
    headers: authHeaders(accessToken),
  })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`hubspot getContact ${crmObjectId} ${resp.status}: ${await resp.text()}`)
  const data = await resp.json()
  return { id: data.id, properties: data.properties ?? {} }
}

export interface BatchUpdateInput { id: string; properties: Record<string, string> }

/** POST /crm/v3/objects/contacts/batch/update. Max 100 records/request (verified 2026-10-09). */
export async function batchUpdateContacts(accessToken: string, inputs: BatchUpdateInput[]): Promise<void> {
  if (inputs.length === 0) return
  if (inputs.length > 100) throw new Error(`batchUpdateContacts: ${inputs.length} exceeds the 100-record max`)
  const resp = await fetch(`${API_BASE}/crm/v3/objects/contacts/batch/update`, {
    method: 'POST', headers: authHeaders(accessToken), body: JSON.stringify({ inputs }),
  })
  if (!resp.ok) throw new Error(`hubspot batchUpdateContacts ${resp.status}: ${await resp.text()}`)
}
