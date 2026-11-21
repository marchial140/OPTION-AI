import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyIdentityCookie, authenticate, getIdentity, startDemo } from '../src/lib/server/auth'
import { listScheduledIdentities, mutateWorkspace, readWorkspace } from '../src/lib/server/store'
import { emptyWorkspace } from '../src/lib/workspace'

const demoUrl = 'http://localhost:3000/api/state'
const liveUrl = 'https://terminal.example.org/api/state'
const userId = 'aa38e3a7-9a62-463d-b9b3-e88831cb3b7a'
let directory: string

function withCookies(url: string, cookie?: string) {
  return new Request(url, cookie ? { headers: { cookie } } : undefined)
}

function configureSupabase() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://workspace.example.org')
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'publishable')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'server-credential')
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'options-storage-'))
  vi.stubEnv('OPTIONS_DATA_DIR', directory)
  vi.stubEnv('DEMO_MODE', undefined)
  vi.stubEnv('DEMO_STORAGE', undefined)
  vi.stubEnv('DEMO_SESSION_SECRET', undefined)
  vi.stubEnv('VERCEL', undefined)
  vi.stubEnv('APP_BASE_URL', undefined)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', undefined)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', undefined)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', undefined)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

describe('local demo persistence', () => {
  it('accepts a signed browser cookie and rejects an altered owner', async () => {
    const identity = await getIdentity(withCookies(demoUrl))
    const response = await applyIdentityCookie(new Response(), identity)
    const cookie = response.headers.getSetCookie().at(0)!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect((await getIdentity(withCookies(demoUrl, cookie.split(';')[0]))).userId).toBe(identity.userId)
    expect((await getIdentity(withCookies(demoUrl, cookie.replace(identity.userId, userId).split(';')[0]))).userId).not.toBe(userId)
  })

  it('preserves independent workspaces and commits concurrent updates', async () => {
    const left = await getIdentity(withCookies(demoUrl))
    const right = await getIdentity(withCookies(demoUrl))
    await Promise.all(Array.from({ length: 12 }, (_, index) => mutateWorkspace(left, (draft) => {
      draft.watchlists.push({ id: `test-${index}`, name: `Liste ${index}`, items: [] })
    })))
    const state = await readWorkspace(left)
    const persisted = await readFile(join(directory, 'demo', `${left.userId}.json`), 'utf8')
    expect(JSON.parse(persisted)).toEqual(state)
    expect(state.watchlists.filter((list) => list.id.startsWith('test-'))).toHaveLength(12)
    expect((await readWorkspace(right)).watchlists.some((list) => list.id.startsWith('test-'))).toBe(false)
  })

  it('returns only durable workspaces that need scheduled processing', async () => {
    const idle = await getIdentity(withCookies(demoUrl))
    const scheduled = await getIdentity(withCookies(demoUrl))
    await readWorkspace(idle)
    await mutateWorkspace(scheduled, (draft) => { draft.settings.schedule.enabled = true })
    expect((await listScheduledIdentities()).map((identity) => identity.userId)).toEqual([scheduled.userId])
  })
})

describe('Supabase integration boundary', () => {
  it('requires verified live identity unless a visitor explicitly selects demo', async () => {
    configureSupabase()
    await expect(getIdentity(withCookies(liveUrl))).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
    const identity = await startDemo(withCookies(liveUrl))
    const cookie = (await applyIdentityCookie(new Response(), identity)).headers.getSetCookie()[0]
    expect(cookie).toMatch(/Secure/)
    const restored = await getIdentity(withCookies(liveUrl, cookie.split(';')[0]))
    expect(restored).toMatchObject({ userId: identity.userId, mode: 'demo' })
  })

  it('validates an access JWT via Supabase before trusting its owner', async () => {
    configureSupabase()
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: userId, email: 'user@example.org' }))
    vi.stubGlobal('fetch', fetchMock)
    const identity = await getIdentity(withCookies(liveUrl, 'options_ai_access=verified-access-token'))
    expect(identity).toMatchObject({ mode: 'live', userId })
    expect(fetchMock).toHaveBeenCalledWith('https://workspace.example.org/auth/v1/user', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer verified-access-token' }),
    }))
  })

  it('keeps both authentication tokens in HttpOnly cookies after sign-in', async () => {
    configureSupabase()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      access_token: 'real-token', refresh_token: 'refresh-secret', expires_in: 1800, user: { id: userId },
    })))
    const result = await authenticate(withCookies(liveUrl), { email: 'user@example.org', password: 'sample-pass', action: 'login' })
    const response = await applyIdentityCookie(new Response(), result.identity!)
    expect(response.headers.getSetCookie()).toEqual([
      expect.stringMatching(/options_ai_access=real-token; .*HttpOnly.*Max-Age=1800.*Secure/u),
      expect.stringMatching(/options_ai_refresh=refresh-secret; .*HttpOnly.*Secure/u),
    ])
  })

  it('starts email confirmation without returning browser tokens', async () => {
    configureSupabase()
    vi.stubEnv('APP_BASE_URL', 'https://terminal.example.org')
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ user: { id: userId } }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await authenticate(withCookies(liveUrl), { email: 'user@example.org', password: 'sample-pass', action: 'signup' })
    expect(result).toEqual({ pendingConfirmation: true })
    const [url, options] = fetchMock.mock.calls[0]
    expect(new URL(url).searchParams.get('redirect_to')).toBe('https://terminal.example.org')
    expect(JSON.parse(options.body)).toMatchObject({
      code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      code_challenge_method: 's256',
    })
  })

  it('lists additional scheduled workspaces beyond the first service page', async () => {
    configureSupabase()
    const rows = Array.from({ length: 200 }, (_, index) => ({
      owner_id: `aa38e3a7-9a62-463d-b9b3-${String(index).padStart(12, '0')}`,
      is_demo: false,
    }))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(rows))
      .mockResolvedValueOnce(Response.json([{ owner_id: userId, is_demo: false }]))
    vi.stubGlobal('fetch', fetchMock)
    const queued = await listScheduledIdentities()
    expect(queued).toHaveLength(201)
    expect(queued[200]).toEqual({ userId, mode: 'live', admin: true })
    const [, options] = fetchMock.mock.calls[1]
    expect(JSON.parse(options.body)).toMatchObject({ p_after_owner: rows[199].owner_id, p_after_demo: false })
  })

  it('replays a conflicted update only against the latest revision', async () => {
    configureSupabase()
    const state = emptyWorkspace('live')
    const latest = emptyWorkspace('live')
    latest.settings.accountCapital = 20_000
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json([{ revision: 4, value: state }]))
      .mockResolvedValueOnce(Response.json(false))
      .mockResolvedValueOnce(Response.json([{ revision: 5, value: latest }]))
      .mockResolvedValueOnce(Response.json(true))
    vi.stubGlobal('fetch', fetchMock)
    const updated = await mutateWorkspace({ mode: 'live', userId, token: 'verified-access-token' }, (draft) => {
      draft.settings.accountCapital += 100
      return draft.settings.accountCapital
    })
    const [, options] = fetchMock.mock.calls[3]
    expect(JSON.parse(options.body)).toMatchObject({
      p_owner: userId, p_demo: false, p_revision: 5, p_value: { settings: { accountCapital: 20_100 } },
    })
    expect(updated).toBe(20_100)
  })
})
