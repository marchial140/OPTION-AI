import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkspaceState } from '@/lib/workspace'
import { seedWorkspace } from './demo-state'
import { dataDirectory, remoteDemoStorage, supabaseConfig, type Identity } from './auth'

const uid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const maxRemoteAttempts = 8
const workspaceCollections = ['watchlists', 'scans', 'portfolio', 'notifications', 'manualQuotes', 'usage', 'reservations'] as const
const wait = (ms: number) => new Promise<void>((finish) => setTimeout(finish, ms))

export class StorageError extends Error {
  constructor(message = 'Le stockage est temporairement indisponible.', readonly status = 503, readonly code = 'STORAGE_UNAVAILABLE') {
    super(message)
    this.name = 'StorageError'
  }
}

function assertIdentity(identity: Identity) {
  if (!uid.test(identity.userId) || (identity.mode !== 'demo' && identity.mode !== 'live')) {
    throw new StorageError('Identité de stockage invalide.', 401, 'STORAGE_IDENTITY')
  }
  if (identity.mode === 'live' && !identity.token && !identity.admin) {
    throw new StorageError('Connectez-vous pour accéder à cet espace.', 401, 'STORAGE_IDENTITY')
  }
}

const table = (identity: Identity) => identity.mode === 'demo' ? 'demo_workspace_states' : 'workspace_states'
const localDirectory = () => resolve(dataDirectory(), 'demo')
const localPath = (identity: Identity) => resolve(localDirectory(), `${identity.userId}.json`)

function usesLocalDisk(identity: Identity) {
  return identity.mode === 'demo' && !remoteDemoStorage()
}

type Version = { value: WorkspaceState; revision: number }

function storageConfig() {
  const config = supabaseConfig()
  if (!config?.serviceRole) {
    throw new StorageError('La connexion au stockage Supabase et sa clé serveur doivent être configurées.', 503, 'STORAGE_CONFIGURATION')
  }
  return { ...config, serviceRole: config.serviceRole }
}

async function storageRequest<T>(path: string, init?: { method: 'POST'; body: string }, accessToken?: string): Promise<T> {
  const config = storageConfig()
  const key = accessToken ? config.key : config.serviceRole
  const authorization = accessToken ?? (key.startsWith('sb_secret_') ? undefined : key)
  try {
    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: key,
        ...(authorization && { Authorization: `Bearer ${authorization}` }),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new StorageError()
    return await response.json() as T
  } catch {
    throw new StorageError()
  }
}

async function readRemote(identity: Identity): Promise<Version> {
  const token = identity.mode === 'live' && !identity.admin ? identity.token : undefined
  const result = await storageRequest<Version[]>(`${table(identity)}?owner_id=eq.${identity.userId}&select=revision,value&limit=1`, undefined, token)
  return result[0] ?? { revision: 0, value: seedWorkspace(identity.mode) }
}

async function readLocal(identity: Identity) {
  let state: unknown
  try {
    state = JSON.parse(await readFile(localPath(identity), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StorageError('Impossible de lire les données de cet espace démo.')
  }
  if (!state || typeof state !== 'object' || !('settings' in state)
    || !state.settings || typeof state.settings !== 'object' || !('schedule' in state.settings)
    || !state.settings.schedule || typeof state.settings.schedule !== 'object'
    || !('enabled' in state.settings.schedule) || typeof state.settings.schedule.enabled !== 'boolean'
    || !workspaceCollections.every((name) => {
      const rows: unknown = Reflect.get(state, name)
      return Array.isArray(rows) && rows.every((row) => row && typeof row === 'object')
    })) {
    throw new StorageError('Les données de cet espace démo sont incomplètes.')
  }
  return state as WorkspaceState
}

export async function readWorkspace(identity: Identity): Promise<WorkspaceState> {
  assertIdentity(identity)
  if (usesLocalDisk(identity)) return await readLocal(identity) ?? mutateLocal(identity, (draft) => draft)
  const stored = await readRemote(identity)
  return stored.revision > 0 ? stored.value : mutateWorkspace(identity, (draft) => draft)
}

function processExists(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    throw error
  }
}

async function removeEmptyLock(path: string) {
  try {
    await rmdir(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

async function removeLockOwner(path: string) {
  try {
    await unlink(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  }
}

async function reclaimLegacyLock(path: string) {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || Date.now() - info.mtimeMs < 2_000) return
  const owner = await readFile(path, 'utf8').catch(() => null)
  if (owner !== null && !processExists(Number(owner))) {
    try {
      await removeLockOwner(path)
    } catch (error) {
      if (!['EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
}

async function reclaimLock(path: string) {
  let owners: string[]
  try {
    owners = await readdir(path)
  } catch (error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case 'ENOENT': return
      case 'ENOTDIR': return reclaimLegacyLock(path)
      default: throw error
    }
  }
  for (const owner of owners) {
    const processId = /^(\d+)-[0-9a-f-]{36}$/u.exec(owner)?.[1]
    if (!processId || processExists(Number(processId))) return
    await removeLockOwner(resolve(path, owner))
  }
  await removeEmptyLock(path)
}

async function acquireLock(path: string) {
  const id = `${process.pid}-${randomUUID()}`
  const staging = `${path}.${id}.tmp`
  await mkdir(staging, { mode: 0o700 })
  try {
    // Rename a nonempty directory into place so its owner is always visible.
    await writeFile(resolve(staging, id), '', { flag: 'wx', mode: 0o600 })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        await rename(staging, path)
        return async () => {
          await removeLockOwner(resolve(path, id))
          await removeEmptyLock(path)
        }
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
        await reclaimLock(path)
        await wait(25 + Math.floor(Math.random() * 20))
      }
    }
    throw new StorageError('Cet espace est occupé. Réessayez dans un instant.', 409, 'STORAGE_CONFLICT')
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

async function mutateLocal<T>(identity: Identity, updater: (draft: WorkspaceState) => T): Promise<T> {
  const path = localPath(identity)
  const lock = `${path}.lock`
  await mkdir(localDirectory(), { recursive: true, mode: 0o700 })
  const release = await acquireLock(lock)
  try {
    const draft = await readLocal(identity) ?? seedWorkspace(identity.mode)
    const result = updater(draft)
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify(draft), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
    return result
  } finally {
    await release()
  }
}

export async function mutateWorkspace<T>(identity: Identity, updater: (draft: WorkspaceState) => T): Promise<T> {
  assertIdentity(identity)
  if (usesLocalDisk(identity)) return mutateLocal(identity, updater)

  // Keep updater synchronous and free of external side effects. A revision conflict can replay it.
  for (let attempt = 0; attempt < maxRemoteAttempts; attempt++) {
    const { value, revision } = await readRemote(identity)
    const result = updater(value)
    const saved = await storageRequest<boolean>('rpc/save_workspace_state', {
      method: 'POST',
      body: JSON.stringify({
        p_owner: identity.userId,
        p_demo: identity.mode === 'demo',
        p_revision: revision,
        p_value: value,
      }),
    })
    if (saved) return result
    await wait(20 * (attempt + 1) + Math.floor(Math.random() * 20))
  }
  throw new StorageError('Les données ont changé pendant l’enregistrement. Réessayez.', 409, 'STORAGE_CONFLICT')
}

function needsJob(state: WorkspaceState) {
  return state.settings.schedule.enabled || state.scans.some((scan) => scan.status === 'queued' || scan.status === 'running')
}

type QueuedWorkspace = { owner_id: string; is_demo: boolean }

async function remoteScheduledIdentities(): Promise<Identity[]> {
  const includeDemo = remoteDemoStorage() && process.env.DEMO_MODE !== 'false'
  const identities: Identity[] = []
  const pageSize = 200
  let after: QueuedWorkspace | undefined
  for (;;) {
    const rows = await storageRequest<QueuedWorkspace[]>('rpc/list_queued_workspaces', {
      method: 'POST',
      body: JSON.stringify({
        p_include_demo: includeDemo,
        p_after_owner: after?.owner_id ?? null,
        p_after_demo: after?.is_demo ?? false,
        p_limit: pageSize,
      }),
    })
    for (const row of rows) {
      if (uid.test(row.owner_id)) {
        identities.push({ mode: row.is_demo ? 'demo' : 'live', userId: row.owner_id, admin: true })
      }
    }
    if (rows.length < pageSize) return identities
    const cursor = rows.at(-1)
    if (!cursor || !uid.test(cursor.owner_id) || (cursor.owner_id === after?.owner_id && cursor.is_demo === after.is_demo)) {
      throw new StorageError()
    }
    after = cursor
  }
}

async function localScheduledIdentities(): Promise<Identity[]> {
  if (remoteDemoStorage() || process.env.DEMO_MODE === 'false') return []
  const names = await readdir(localDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const identities: Identity[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const userId = name.slice(0, -5)
    if (!uid.test(userId)) continue
    const identity: Identity = { mode: 'demo', userId, admin: true }
    let state: WorkspaceState | null
    try {
      state = await readLocal(identity)
    } catch (error) {
      if (!(error instanceof StorageError)) throw error
      continue
    }
    if (state && needsJob(state)) identities.push(identity)
  }
  return identities
}

export async function listScheduledIdentities(): Promise<Identity[]> {
  const [remote, local] = await Promise.all([
    supabaseConfig()?.serviceRole ? remoteScheduledIdentities() : [],
    localScheduledIdentities(),
  ])
  return [...remote, ...local].sort((a, b) => a.userId.localeCompare(b.userId) || a.mode.localeCompare(b.mode))
}
