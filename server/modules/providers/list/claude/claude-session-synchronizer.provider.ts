import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
};

type TranscriptTitles = {
  /** Latest explicit rename (custom-title entry) — authoritative. */
  renamed?: string;
  /** Latest generated title (ai-title / last-prompt) — fallback only. */
  derived?: string;
};

/**
 * Scans a transcript backwards for its title entries.
 *
 * Renames made in Claude Code (the CLI resume picker or the desktop app)
 * append a `custom-title` entry to the transcript, so the most recent one is
 * the user's chosen name and takes precedence over everything else. Generated
 * titles (`ai-title`, `last-prompt`) are collected separately as fallbacks.
 * Entries whose sessionId does not match are skipped: forked sessions copy
 * the parent transcript prefix, including the parent's title entries.
 *
 * Exported so the sessions watcher can reuse it to backfill names for
 * already-indexed sessions at startup.
 */
export async function extractClaudeSessionTitles(
  filePath: string,
  sessionId: string
): Promise<TranscriptTitles> {
  const titles: TranscriptTitles = {};

  try {
    const content = await readFile(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const data = parsed as Record<string, unknown>;
      if (typeof data.sessionId !== 'string' || data.sessionId !== sessionId) {
        continue;
      }

      const eventType = typeof data.type === 'string' ? data.type : undefined;
      if (eventType === 'custom-title') {
        const customTitle = typeof data.customTitle === 'string' ? data.customTitle : undefined;
        if (customTitle?.trim()) {
          titles.renamed = customTitle;
          break;
        }
        continue;
      }

      if (titles.derived) {
        continue;
      }

      const aiTitle = typeof data.aiTitle === 'string' ? data.aiTitle : undefined;
      const lastPrompt = typeof data.lastPrompt === 'string' ? data.lastPrompt : undefined;
      if (
        (eventType === 'ai-title' && aiTitle?.trim()) ||
        (eventType === 'last-prompt' && lastPrompt?.trim())
      ) {
        titles.derived = aiTitle || lastPrompt;
      }
    }
  } catch {
    // Ignore missing/unreadable files so sync can continue.
  }

  return titles;
}

/**
 * Session indexer for Claude transcript artifacts.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'claude' as const;
  private readonly claudeHome = path.join(os.homedir(), '.claude');

  /**
   * Returns true when a JSONL file is a subagent transcript rather than a
   * top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    return path.normalize(filePath).split(path.sep).includes('subagents');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.claudeHome, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.claudeHome, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath
    );
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    // The transcript filename is the session's own id. A resumed session copies
    // the parent session's message prefix verbatim, so the first content line's
    // `sessionId` is the PARENT's id, not this file's. Reading the id from there
    // mis-keys the row (and lets one child transcript clobber the parent row's
    // jsonl_path) and makes rename entries — which are written with this
    // session's real id — never match. Deriving the id from the filename is both
    // correct and matches Claude Code's own naming convention.
    const sessionId = path.basename(filePath, '.jsonl');

    const projectPath = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      return typeof data.cwd === 'string' ? data.cwd : null;
    });

    if (!projectPath) {
      return null;
    }

    const parsed: ParsedSession = { sessionId, projectPath };

    // An explicit rename in Claude Code always wins, so names stay mirrored
    // even after this app has stored a different one.
    const titles = await extractClaudeSessionTitles(filePath, parsed.sessionId);
    if (titles.renamed) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(titles.renamed, 'Untitled Claude Session'),
      };
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    if (existingSessionName && existingSessionName !== 'Untitled Claude Session') {
      return {
        ...parsed,
        sessionName: normalizeSessionName(existingSessionName, 'Untitled Claude Session'),
      };
    }

    const sessionName = nameMap.get(parsed.sessionId) ?? titles.derived;

    return {
      ...parsed,
      sessionName: normalizeSessionName(sessionName, 'Untitled Claude Session'),
    };
  }
}
