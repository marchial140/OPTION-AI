import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'

const demoCookie = 'options_ai_demo'
const accessCookie = 'options_ai_access'
const refreshCookie = 'options_ai_refresh'
const identityPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const demoMaxAge = 60 * 60 * 24 * 180
const requestOptions = { cache: 'no-store', redirect: 'error' } as const

export type Identity = {
  mode: 'demo' | 'live'
  userId: string
  email?: string
  token?: string
  refreshToken?: string
  accessExpiresIn?: number
  setCookie?: boolean
  secure?: boolean
  admin?: boolean
}

export class AuthError extends Error {
  constructor(message: string, readonly status = 401, readonly code = 'AUTH_REQUIRED') {
    super(message)
    this.name = 'AuthError'
  }
}

export function supabaseConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/u, '')
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url || !key) return null
  try {
    const parsed = new URL(url)
    const isLocal = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) throw new Error()
    if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== '/')) throw new Error()
  } catch {
    throw new AuthError('Adresse Supabase invalide.', 503, 'AUTH_CONFIGURATION')
  }
  return { url, key, serviceRole }
}

export function dataDirectory() {
  return resolve(/* turbopackIgnore: true */ process.env.OPTIONS_DATA_DIR?.trim() || '.data')
}

export function isHosted() {
  return process.env.VERCEL === '1'
}

export function remoteDemoStorage() {
  return isHosted() || process.env.DEMO_STORAGE === 'supabase'
}

export function demoAvailable() {
  if (process.env.DEMO_MODE === 'false') return false
  const key = process.env.DEMO_SESSION_SECRET?.trim()
  if (key && key.length < 32) return false
  if (!remoteDemoStorage()) return true
  return Boolean(key && supabaseConfig()?.serviceRole)
}

function secureRequest(request?: Request) {
  return isHosted() || Boolean(process.env.APP_BASE_URL?.trim().startsWith('https://')) ||
    Boolean(request && new URL(request.url).protocol === 'https:')
}

function readCookie(request: Request, name: string) {
  for (const field of request.headers.get('cookie')?.split(';') ?? []) {
    const [key, ...value] = field.trim().split('=')
    if (key !== name || !value.length) continue
    try {
      return decodeURIComponent(value.join('='))
    } catch {
      return undefined
    }
  }
}

function setCookie(response: Response, name: string, value: string, maxAge: number, secure: boolean) {
  const options = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (secure) options.push('Secure')
  response.headers.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; ${options.join('; ')}`)
}

async function demoKey() {
  const configured = process.env.DEMO_SESSION_SECRET?.trim()
  if (configured) {
    if (configured.length < 32) throw new AuthError('La clé des sessions démo doit comporter au moins 32 caractères.', 503, 'DEMO_CONFIGURATION')
    return configured
  }
  if (isHosted() || process.env.DEMO_STORAGE === 'supabase') throw new AuthError('Le mode démo nécessite une clé de session sur cet hébergement.', 503, 'DEMO_CONFIGURATION')

  await mkdir(dataDirectory(), { recursive: true, mode: 0o700 })
  const path = resolve(dataDirectory(), '.demo-session-key')
  try {
    return await readDemoKey(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const key = randomBytes(48).toString('base64url')
  try {
    await writeFile(path, key, { flag: 'wx', mode: 0o600 })
    return key
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readDemoKey(path)
  }
}

async function readDemoKey(path: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = await readFile(path, 'utf8')
    if (key.length >= 32) return key
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new AuthError('Clé de session locale invalide.', 503, 'DEMO_CONFIGURATION')
}

function demoSignature(userId: string, expiresAt: string, key: string) {
  return createHmac('sha256', key).update(`options-ai-demo:${userId}:${expiresAt}`).digest('base64url')
}

async function demoIdentity(request: Request): Promise<Identity> {
  if (process.env.DEMO_MODE === 'false') throw new AuthError('Le mode démo est désactivé.', 403, 'DEMO_DISABLED')
  if (remoteDemoStorage() && !supabaseConfig()?.serviceRole) {
    throw new AuthError('Le stockage du mode démo hébergé doit être configuré.', 503, 'DEMO_CONFIGURATION')
  }
  const key = await demoKey()
  const value = readCookie(request, demoCookie)
  const [id, expiresAt, signature, extra] = value?.split('.') ?? []
  if (id && expiresAt && signature && extra === undefined && identityPattern.test(id)
    && /^\d{10}$/u.test(expiresAt) && Number(expiresAt) > Math.floor(Date.now() / 1000)) {
    const received = Buffer.from(signature)
    const expected = Buffer.from(demoSignature(id, expiresAt, key))
    if (received.length === expected.length && timingSafeEqual(received, expected)) {
      return { mode: 'demo', userId: id, secure: secureRequest(request) }
    }
  }
  return { mode: 'demo', userId: randomUUID(), setCookie: true, secure: secureRequest(request) }
}

const authUser = z.object({ id: z.string().uuid(), email: z.string().optional() })
const userResponse = z.union([authUser, z.object({ user: authUser }).transform(({ user }) => user)])
const authSession = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  user: authUser,
})

function fromSession(session: z.infer<typeof authSession>, request: Request): Identity {
  return {
    mode: 'live',
    userId: session.user.id,
    email: session.user.email,
    token: session.access_token,
    refreshToken: session.refresh_token,
    accessExpiresIn: session.expires_in,
    setCookie: true,
    secure: secureRequest(request),
  }
}

async function askSupabase(config: NonNullable<ReturnType<typeof supabaseConfig>>, endpoint: string, init: RequestInit = {}) {
  try {
    const response = await fetch(`${config.url}/auth/v1/${endpoint}`, {
      ...requestOptions,
      ...init,
      headers: { apikey: config.key, 'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01', ...init.headers },
      signal: AbortSignal.timeout(8_000),
    })
    return { status: response.status, body: await response.json().catch(() => null) as unknown }
  } catch {
    throw new AuthError('Le service de connexion est temporairement indisponible.', 503, 'AUTH_UNAVAILABLE')
  }
}

export async function getIdentity(request: Request): Promise<Identity> {
  const config = supabaseConfig()
  if (config) {
    const token = readCookie(request, accessCookie)
    if (token) {
      const { status, body } = await askSupabase(config, 'user', { headers: { Authorization: `Bearer ${token}` } })
      if (status === 200) {
        const user = userResponse.safeParse(body)
        if (user.success) {
          return { mode: 'live', userId: user.data.id, email: user.data.email, token, secure: secureRequest(request) }
        }
      }
      if (status === 429 || status >= 500) throw new AuthError('Le service de connexion est temporairement indisponible.', 503, 'AUTH_UNAVAILABLE')
    }
    const refreshToken = readCookie(request, refreshCookie)
    if (refreshToken) {
      const { status, body } = await askSupabase(config, 'token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refreshToken }),
      })
      if (status === 200) {
        const session = authSession.safeParse(body)
        if (session.success) return fromSession(session.data, request)
      }
      if (status === 429 || status >= 500) throw new AuthError('Le service de connexion est temporairement indisponible.', 503, 'AUTH_UNAVAILABLE')
    }
    if (token || refreshToken) throw new AuthError('Votre session a expiré. Reconnectez-vous.')
  }
  if (process.env.DEMO_MODE === 'true' || (process.env.DEMO_MODE !== 'false' && (!config || readCookie(request, demoCookie)))) {
    return demoIdentity(request)
  }
  throw new AuthError('Connectez-vous pour ouvrir votre espace de recherche.')
}

export async function startDemo(request: Request) {
  return demoIdentity(request)
}

export async function authenticate(request: Request, credentials: { email: string; password: string; action: 'login' | 'signup' }) {
  const config = supabaseConfig()
  if (!config) throw new AuthError('Supabase Auth doit être configuré pour activer la connexion.', 503, 'AUTH_CONFIGURATION')
  const signup = credentials.action === 'signup'
  const redirect = signup && process.env.APP_BASE_URL?.trim()
  const endpoint = signup ? (redirect ? `signup?redirect_to=${encodeURIComponent(redirect)}` : 'signup') : 'token?grant_type=password'
  // Verify the email through Supabase, then sign in by password. The PKCE
  // challenge keeps the confirmation redirect from returning browser tokens.
  const confirmation = signup ? {
    code_challenge: createHash('sha256').update(randomBytes(48).toString('base64url')).digest('base64url'),
    code_challenge_method: 's256',
  } : undefined
  const { status, body } = await askSupabase(config, endpoint, {
    method: 'POST',
    body: JSON.stringify({ email: credentials.email, password: credentials.password, ...confirmation }),
  })
  if (status >= 200 && status < 300) {
    const session = authSession.safeParse(body)
    if (session.success) return { identity: fromSession(session.data, request), pendingConfirmation: false }
    if (signup && userResponse.safeParse(body).success) return { pendingConfirmation: true }
  }
  if (status === 429) throw new AuthError('Trop de tentatives. Réessayez dans quelques instants.', 429, 'AUTH_RATE_LIMIT')
  if (status >= 500) throw new AuthError('Le service de connexion est temporairement indisponible.', 503, 'AUTH_UNAVAILABLE')
  throw new AuthError(signup ? 'Inscription impossible avec ces informations.' : 'Adresse ou mot de passe invalide.', 401, 'AUTH_INVALID')
}

export async function logout(request: Request) {
  const config = supabaseConfig()
  const token = readCookie(request, accessCookie)
  if (config && token) {
    await askSupabase(config, 'logout?scope=local', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null)
  }
}

export async function applyIdentityCookie<T extends Response>(response: T, identity: Identity): Promise<T> {
  if (!identity.setCookie) return response
  const secure = identity.secure ?? isHosted()
  if (identity.mode === 'demo') {
    const expiresAt = String(Math.floor(Date.now() / 1000) + demoMaxAge)
    const signature = demoSignature(identity.userId, expiresAt, await demoKey())
    setCookie(response, demoCookie, `${identity.userId}.${expiresAt}.${signature}`, demoMaxAge, secure)
  } else if (identity.token && identity.refreshToken) {
    setCookie(response, accessCookie, identity.token, identity.accessExpiresIn ?? 3600, secure)
    setCookie(response, refreshCookie, identity.refreshToken, 60 * 60 * 24 * 30, secure)
  }
  return response
}

export function clearAuthCookies<T extends Response>(response: T, request?: Request): T {
  const secure = secureRequest(request)
  setCookie(response, accessCookie, '', 0, secure)
  setCookie(response, refreshCookie, '', 0, secure)
  return response
}

export function clearDemoCookie<T extends Response>(response: T, request?: Request): T {
  setCookie(response, demoCookie, '', 0, secureRequest(request))
  return response
}
