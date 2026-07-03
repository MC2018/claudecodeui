import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises, createReadStream } from 'node:fs';
import readline from 'node:readline';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';

/**
 * Mirrors Claude Code *desktop app* session state into the local database.
 *
 * The desktop app never deletes transcript files: archiving or deleting a
 * session there only updates its private metadata store at
 * `~/.config/Claude/claude-code-sessions/<install>/<workspace>/local_<id>.json`
 * (each file carries `cliSessionId` and `isArchived`). The transcript-file
 * watcher therefore never sees those actions, and desktop-removed sessions
 * pile up in the sidebar forever.
 *
 * This service reconciles one-directionally, desktop app -> local DB:
 * - desktop metadata says `isArchived: true`  -> archive the session row
 * - desktop metadata file removed (deleted in the app) -> archive the row,
 *   but only for transcripts stamped `entrypoint: claude-desktop`; sessions
 *   from other entrypoints (cli, vscode, sdk) legitimately have no metadata.
 *
 * Rows are archived, never hard-deleted, so a mistaken match is always
 * recoverable from the archived-sessions view. Sessions the user archived in
 * this app are never un-archived by the desktop state.
 */

const DESKTOP_SESSIONS_STORE = path.join(os.homedir(), '.config', 'Claude', 'claude-code-sessions');

/**
 * A desktop session created moments ago may have its transcript on disk
 * before this service observes the metadata file. Never treat transcripts
 * with recent activity as desktop-deleted.
 */
const RECENT_ACTIVITY_GRACE_MS = 15 * 60 * 1000;

const RECONCILE_DEBOUNCE_MS = 1_000;

let watcher: FSWatcher | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileInFlight = false;
let reconcileQueued = false;

/** Entrypoints are immutable once written, so cache per transcript path. */
const entrypointCache = new Map<string, string | null>();

function isDesktopMetadataFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base.startsWith('local_') && base.endsWith('.json');
}

/**
 * Reads the desktop store and returns cli-session-id -> isArchived.
 * Returns null when the store does not exist (desktop app not installed).
 */
async function readDesktopSessionStates(): Promise<Map<string, boolean> | null> {
  let installDirs: string[];
  try {
    installDirs = await fsPromises.readdir(DESKTOP_SESSIONS_STORE);
  } catch {
    return null;
  }

  const states = new Map<string, boolean>();
  for (const installDir of installDirs) {
    const installPath = path.join(DESKTOP_SESSIONS_STORE, installDir);
    let workspaceDirs: string[];
    try {
      workspaceDirs = await fsPromises.readdir(installPath);
    } catch {
      continue;
    }

    for (const workspaceDir of workspaceDirs) {
      const workspacePath = path.join(installPath, workspaceDir);
      let entries: string[];
      try {
        entries = await fsPromises.readdir(workspacePath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!isDesktopMetadataFile(entry)) {
          continue;
        }

        try {
          const raw = await fsPromises.readFile(path.join(workspacePath, entry), 'utf8');
          const data = JSON.parse(raw) as { cliSessionId?: unknown; isArchived?: unknown };
          if (typeof data.cliSessionId === 'string' && data.cliSessionId) {
            // A session can appear in several metadata files across
            // workspaces; treat it as archived only if every copy agrees.
            const existing = states.get(data.cliSessionId);
            const archived = data.isArchived === true;
            states.set(data.cliSessionId, existing === undefined ? archived : existing && archived);
          }
        } catch {
          // Unreadable metadata never triggers an archive.
        }
      }
    }
  }

  return states;
}

/**
 * Extracts the `entrypoint` stamp from a transcript, reading only as many
 * lines as needed (the first user message carries it).
 */
async function readTranscriptEntrypoint(jsonlPath: string): Promise<string | null> {
  if (entrypointCache.has(jsonlPath)) {
    return entrypointCache.get(jsonlPath) ?? null;
  }

  let entrypoint: string | null = null;
  try {
    const stream = createReadStream(jsonlPath, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let scanned = 0;
    for await (const line of lines) {
      scanned += 1;
      if (scanned > 200) {
        break;
      }

      try {
        const data = JSON.parse(line) as { entrypoint?: unknown };
        if (typeof data.entrypoint === 'string') {
          entrypoint = data.entrypoint;
          break;
        }
      } catch {
        continue;
      }
    }
    lines.close();
    stream.destroy();
  } catch {
    return null;
  }

  entrypointCache.set(jsonlPath, entrypoint);
  return entrypoint;
}

async function hasRecentActivity(jsonlPath: string): Promise<boolean> {
  try {
    const stats = await fsPromises.stat(jsonlPath);
    return Date.now() - stats.mtimeMs < RECENT_ACTIVITY_GRACE_MS;
  } catch {
    // Missing transcript is the file watcher's concern, not this service's.
    return true;
  }
}

function broadcastSessionRemoval(sessionId: string, projectPath: string | null): void {
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const event = JSON.stringify({
    kind: 'session_deleted',
    sessionId,
    provider: 'claude',
    projectId: project?.project_id ?? null,
    projectPath: projectPath ?? null,
    timestamp: new Date().toISOString(),
  });

  connectedClients.forEach(client => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(event);
    }
  });
}

/**
 * One reconcile pass: archives active claude rows the desktop app has
 * archived or deleted. Returns the number of rows archived.
 */
export async function reconcileDesktopSessionState(): Promise<number> {
  const desktopStates = await readDesktopSessionStates();
  if (desktopStates === null) {
    return 0;
  }

  let archived = 0;
  for (const row of sessionsDb.getAllSessions()) {
    if (row.provider !== 'claude') {
      continue;
    }

    const cliSessionId = row.provider_session_id ?? row.session_id;
    const desktopArchived = desktopStates.get(cliSessionId);

    let shouldArchive = false;
    if (desktopArchived === true) {
      shouldArchive = true;
    } else if (desktopArchived === undefined && row.jsonl_path) {
      // No metadata: only a desktop-owned transcript means the app deleted
      // the session. Skip transcripts with fresh activity so a brand-new
      // desktop session is never archived before its metadata appears.
      const entrypoint = await readTranscriptEntrypoint(row.jsonl_path);
      if (entrypoint === 'claude-desktop' && !(await hasRecentActivity(row.jsonl_path))) {
        shouldArchive = true;
      }
    }

    if (!shouldArchive) {
      continue;
    }

    sessionsDb.updateSessionIsArchived(row.session_id, true);
    broadcastSessionRemoval(row.session_id, row.project_path);
    archived += 1;
  }

  return archived;
}

function scheduleReconcile(): void {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void runReconcile();
  }, RECONCILE_DEBOUNCE_MS);
}

async function runReconcile(): Promise<void> {
  if (reconcileInFlight) {
    reconcileQueued = true;
    return;
  }

  reconcileInFlight = true;
  try {
    const archived = await reconcileDesktopSessionState();
    if (archived > 0) {
      console.log('Archived sessions to mirror Claude desktop app state', { archived });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Desktop session state reconcile failed', { error: message });
  } finally {
    reconcileInFlight = false;
    if (reconcileQueued) {
      reconcileQueued = false;
      scheduleReconcile();
    }
  }
}

/**
 * Starts the desktop store watcher after one initial reconcile pass.
 * No-op when the desktop app store does not exist.
 */
export async function initializeDesktopAppSync(): Promise<void> {
  try {
    await fsPromises.access(DESKTOP_SESSIONS_STORE);
  } catch {
    return;
  }

  console.log('Setting up Claude desktop app session sync');
  await runReconcile();

  watcher = chokidar.watch(DESKTOP_SESSIONS_STORE, {
    persistent: true,
    ignoreInitial: true,
    followSymlinks: false,
    depth: 4,
    usePolling: true,
    interval: 6_000,
    binaryInterval: 6_000,
  });

  const onStoreEvent = (filePath: string): void => {
    if (isDesktopMetadataFile(filePath)) {
      scheduleReconcile();
    }
  };

  watcher
    .on('add', onStoreEvent)
    .on('change', onStoreEvent)
    .on('unlink', onStoreEvent)
    .on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Desktop app session sync watcher error', { error: message });
    });
}

/**
 * Stops the desktop store watcher.
 */
export async function closeDesktopAppSync(): Promise<void> {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }

  if (watcher) {
    try {
      await watcher.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Failed to close desktop app session sync watcher', { error: message });
    }
    watcher = null;
  }

  entrypointCache.clear();
  reconcileQueued = false;
  reconcileInFlight = false;
}
