import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import { extractClaudeSessionTitles } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';
import type { LLMProvider } from '@/shared/types.js';
import { generateDisplayName } from '@/modules/projects/index.js';

type WatcherEventType = 'add' | 'change' | 'unlink';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  // {
  //   provider: 'gemini',
  //   rootPath: path.join(os.homedir(), '.gemini', 'sessions'),
  // },
  // Keep `sessions/` watcher disabled: Gemini also mirrors artifacts there,
  // which causes duplicate synchronization events.
  {
    provider: 'gemini',
    rootPath: path.join(os.homedir(), '.gemini', 'tmp'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
];

const WATCHER_IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/*.tmp',
  '**/*.swp',
  '**/.DS_Store',
];

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
  /**
   * Transcript files reported deleted by the watcher. Resolution to session
   * rows happens at flush time, after re-checking the file is still gone, so
   * editors that replace a file via unlink+add never tear down a live row.
   */
  removedFiles: Map<string, LLMProvider>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  if (provider === 'gemini') {
    return filePath.endsWith('.json') || filePath.endsWith('.jsonl');
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null,
  removedFilePath?: string
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
      removedFiles: new Map<string, LLMProvider>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }
  if (removedFilePath) {
    pendingWatcherUpdate.removedFiles.set(removedFilePath, provider);
  }

  schedulePendingWatcherFlush();
}

/**
 * Builds one `session_upserted` delta event for a provider-native session id.
 *
 * The event carries everything a sidebar needs to upsert the session in place
 * (session summary plus owning-project metadata), so clients never need a full
 * project-list refetch when a transcript file changes on disk. Returns `null`
 * when the id cannot be resolved to an indexed session row.
 */
async function buildSessionUpsertedEvent(updatedProviderSessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(updatedProviderSessionId)
    ?? sessionsDb.getSessionById(updatedProviderSessionId);
  if (!row || row.isArchived) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;
  const displayName = project?.custom_project_name?.trim()
    ? project.custom_project_name
    : await generateDisplayName(path.basename(projectPath ?? '') || (projectPath ?? ''), projectPath);

  return JSON.stringify({
    kind: 'session_upserted',
    sessionId: row.session_id,
    provider: row.provider,
    session: {
      id: row.session_id,
      summary: row.custom_name || '',
      messageCount: 0,
      lastActivity: row.updated_at ?? row.created_at ?? new Date().toISOString(),
    },
    project: project
      ? {
        projectId: project.project_id,
        path: project.project_path,
        fullPath: project.project_path,
        displayName,
        isStarred: Boolean(project.isStarred),
      }
      : null,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Mirrors one transcript file deletion into the database.
 *
 * Resolves the owning session row (by exact transcript path first, then by
 * the file name stem, which is the provider-native session id for claude and
 * cursor transcripts), deletes it, and returns a `session_deleted` event for
 * connected clients. Returns `null` when the file reappeared (atomic replace)
 * or no row claims it.
 */
async function processRemovedFile(filePath: string): Promise<string | null> {
  // Re-check existence at flush time: an unlink immediately followed by an
  // add (file replaced in place) must not delete the session row.
  try {
    await fsPromises.access(filePath);
    return null;
  } catch {
    // Still gone — proceed with the deletion.
  }

  const fileStem = path.basename(filePath, path.extname(filePath));
  let row = sessionsDb.getSessionByJsonlPath(filePath);
  if (!row) {
    // Fall back to the provider-native id in the file name, but only when the
    // row does not claim a different transcript file elsewhere on disk.
    const candidate = sessionsDb.getSessionByProviderSessionId(fileStem)
      ?? sessionsDb.getSessionById(fileStem);
    if (candidate && (!candidate.jsonl_path || candidate.jsonl_path === filePath)) {
      row = candidate;
    }
  }

  if (!row) {
    return null;
  }

  const projectPath = row.project_path;
  const project = projectPath ? projectsDb.getProjectPath(projectPath) : null;

  sessionsDb.deleteSessionById(row.session_id);
  console.log('Session removed after transcript deletion on disk', {
    sessionId: row.session_id,
    filePath,
  });

  return JSON.stringify({
    kind: 'session_deleted',
    sessionId: row.session_id,
    provider: row.provider,
    projectId: project?.project_id ?? null,
    projectPath: projectPath ?? null,
    timestamp: new Date().toISOString(),
  });
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    const events: string[] = [];
    for (const updatedSessionId of queuedUpdate.updatedSessionIds) {
      const event = await buildSessionUpsertedEvent(updatedSessionId);
      if (event) {
        events.push(event);
      }
    }

    for (const [removedFilePath] of queuedUpdate.removedFiles) {
      const event = await processRemovedFile(removedFilePath);
      if (event) {
        events.push(event);
      }
    }

    if (events.length > 0) {
      connectedClients.forEach(client => {
        if (client.readyState === WS_OPEN_STATE) {
          for (const event of events) {
            client.send(event);
          }
        }
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Handles transcript file deletions so external session removals (e.g. from
 * the Claude Code CLI) are mirrored into the database and pushed to clients.
 */
function onRemove(filePath: string, provider: LLMProvider): void {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  // Subagent transcripts share the parent session's id; their removal must
  // never tear down the parent session row.
  if (path.normalize(filePath).split(path.sep).includes('subagents')) {
    return;
  }

  queuePendingWatcherUpdate('unlink', provider, null, filePath);
}

/**
 * Removes session rows whose transcript file disappeared while the server was
 * not running, so externally deleted sessions do not linger in the sidebar.
 */
async function pruneSessionsWithMissingTranscripts(): Promise<number> {
  let pruned = 0;

  for (const row of sessionsDb.getSessionsWithJsonlPath()) {
    if (!row.jsonl_path) {
      continue;
    }

    try {
      await fsPromises.access(row.jsonl_path);
    } catch {
      sessionsDb.deleteSessionById(row.session_id);
      pruned += 1;
    }
  }

  return pruned;
}

/**
 * Backfills session names from renames recorded in Claude transcripts.
 *
 * The startup synchronizer is incremental (only files created since the last
 * scan), so a rename made in Claude Code while this server was not watching
 * would otherwise only be picked up whenever that transcript next changes.
 */
async function backfillClaudeSessionNames(): Promise<number> {
  let renamed = 0;

  for (const row of sessionsDb.getSessionsWithJsonlPath()) {
    if (row.provider !== 'claude' || !row.jsonl_path) {
      continue;
    }

    const titles = await extractClaudeSessionTitles(
      row.jsonl_path,
      row.provider_session_id ?? row.session_id
    );
    if (titles.renamed && titles.renamed !== row.custom_name) {
      sessionsDb.updateSessionCustomName(row.session_id, titles.renamed);
      renamed += 1;
    }
  }

  return renamed;
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    failures: initialSync.failures,
  });

  try {
    const pruned = await pruneSessionsWithMissingTranscripts();
    if (pruned > 0) {
      console.log('Pruned sessions whose transcripts were deleted externally', { pruned });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to prune sessions with missing transcripts', { error: message });
  }

  try {
    const renamed = await backfillClaudeSessionNames();
    if (renamed > 0) {
      console.log('Backfilled session names from Claude transcript renames', { renamed });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Failed to backfill session names from transcripts', { error: message });
  }

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: WATCHER_IGNORED_PATTERNS,
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('unlink', (filePath: string) => {
          onRemove(filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
