import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { WorkspaceState } from '@/lib/workspace'
import { seedWorkspace } from './demo-state'
import { dataDirectory, remoteDemoStorage, supabaseConfig, type Identity } from './auth'

const uid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const maxRemoteAttempts = 8
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

async function storageRequest<T>(path: string, init?: { method: 'POST'; body: string }): Promise<T> {
  const config = storageConfig()
  try {
    const response = await fetch(`${config.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: config.serviceRole,
        ...(!config.serviceRole.startsWith('sb_secret_') && { Authorization: `Bearer ${config.serviceRole}` }),
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
  const result = await storageRequest<Version[]>(`${table(identity)}?owner_id=eq.${identity.userId}&select=revision,value&limit=1`)
  return result[0] ?? { revision: 0, value: seedWorkspace(identity.mode) }
}

async function readLocal(identity: Identity) {
  try {
    return JSON.parse(await readFile(localPath(identity), 'utf8')) as WorkspaceState
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new StorageError('Impossible de lire les données de cet espace démo.')
  }
}

export async function readWorkspace(identity: Identity): Promise<WorkspaceState> {
  assertIdentity(identity)
  if (usesLocalDisk(identity)) return await readLocal(identity) ?? mutateLocal(identity, (draft) => draft)
  const stored = await readRemote(identity)
  return stored.revision > 0 ? stored.value : mutateWorkspace(identity, (draft) => draft)
}

async function reclaimLock(path: string) {
  const recovery = `${path}.recovery`
  const info = await stat(path).catch(() => null)
  if (!info || Date.now() - info.mtimeMs < 2_000) return
  try {
    await mkdir(recovery)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
    throw error
  }
  try {
    const owner = await readFile(path, 'utf8').catch(() => null)
    if (owner === null) return
    const pid = Number(owner)
    const current = await stat(path).catch(() => null)
    if (!current || Date.now() - current.mtimeMs < 2_000) return
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EPERM') return
        if (code !== 'ESRCH') throw error
      }
    }
    await rm(path, { force: true })
  } finally {
    await rm(recovery, { recursive: true, force: true })
  }
}

async function acquireLock(path: string) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      const file = await open(path, 'wx', 0o600)
      try {
        await file.writeFile(String(process.pid), 'utf8')
      } catch (error) {
        await rm(path, { force: true })
        throw error
      } finally {
        await file.close()
      }
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await reclaimLock(path)
      await wait(25 + Math.floor(Math.random() * 20))
    }
  }
  throw new StorageError('Cet espace est occupé. Réessayez dans un instant.', 409, 'STORAGE_CONFLICT')
}

async function mutateLocal<T>(identity: Identity, updater: (draft: WorkspaceState) => T): Promise<T> {
  const path = localPath(identity)
  const lock = `${path}.lock`
  await mkdir(localDirectory(), { recursive: true, mode: 0o700 })
  await acquireLock(lock)
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
    await rm(lock, { force: true })
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
    const state = await readLocal(identity)
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
