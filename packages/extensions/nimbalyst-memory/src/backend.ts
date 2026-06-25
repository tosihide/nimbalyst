/**
 * Nimbalyst Memory — backend module.
 *
 * Runs in an Electron utility-process (outside main and the renderer). It hosts
 * the host-agnostic `MemoryEngine` directly (NOT over the engine's stdio MCP
 * server): better-sqlite3 shadow store, fs walk, and OpenAI fetch embeddings.
 * It exposes the engine's capabilities as backend RPC methods and registers
 * them with the host's unified MCP surface via `services.registerMcpTools`, so
 * the coding agent and (for voice-flagged tools) the voice agent reach the
 * engine in-process — sub-second, no 60s `ask_coding_agent` round-trip.
 *
 * The OpenAI key comes ONLY from the `getApiKey` broker (the user's explicitly
 * configured Nimbalyst AI key) — never `process.env` (CLAUDE.md rule). With no
 * key configured the module still loads and advertises its tools; they return a
 * clear "configure your OpenAI key" error until one is set.
 *
 * The method-name keys below MUST match the `name`s passed to registerMcpTools:
 * the host advertises `<ext-short>.<name>` and routes a call back to the RPC
 * method of the same `name`.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { MemoryEngine } from '../engine/dist/index.js';
import { createEmbedder } from '../engine/dist/index.js';
import type { EngineConfig, SourceSet } from '../engine/dist/index.js';
import {
  buildDistillMessages,
  parseDistillResponse,
  type ChatMessage,
  type FactCandidate,
} from './distill';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Subset of the host's BackendActivateContext we rely on. */
interface ActivateCtx {
  services: {
    workspacePath: string;
    extensionPath: string;
    /**
     * Per-(extension, workspace) writable dir under the app's userData. The
     * shadow index lives here so it never lands inside the user's project tree.
     */
    dataDir: string;
    log: (level: LogLevel, message: string, data?: unknown) => void;
    getApiKey: (providerId: string) => Promise<{ key: string | null }>;
    registerMcpTools: (
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        voiceAgent?: boolean;
        scope?: 'global' | 'editor';
      }>
    ) => Promise<{ registered: string[] }>;
  };
}

const FACTS_DIR = 'nimbalyst-local/voice-memory';

/** Where plan markdown lives (the 'plans' source class). Nimbalyst convention,
 *  so it stays here in the app-facing backend half, not in the engine. */
const PLANS_DIR = 'nimbalyst-local/plans';

/** Cap plan/doc bodies returned to the voice agent. The Realtime model degrades
 *  on very large function results; this is enough for a summarize-back of a long
 *  plan while staying within the voice turn budget. */
const MAX_DOC_CHARS = 12000;

function capForVoice(content: string): { content: string; truncated: boolean } {
  if (content.length <= MAX_DOC_CHARS) return { content, truncated: false };
  return { content: content.slice(0, MAX_DOC_CHARS) + '\n\n…(truncated)', truncated: true };
}

/** Chat model used for auto-distillation. Cheap + good at structured extraction. */
const DISTILL_MODEL = 'gpt-4o-mini';

/**
 * One-shot OpenAI chat completion for fact distillation. Mirrors the embedder's
 * raw-fetch approach (key from the broker, never process.env) so the backend
 * module needs no extra dependency. Returns the assistant message text.
 */
async function chatComplete(messages: ChatMessage[], apiKey: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DISTILL_MODEL,
      temperature: 0,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI chat completion failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}

/**
 * Resolve a plan reference to a root-relative path. Accepts a full relative path
 * (returned as-is) or a bare name like "voice-agent-grounding-system" / "foo.md"
 * (resolved under the plans dir, .md appended if missing).
 */
function resolvePlanPath(ref: string): string {
  const trimmed = ref.trim().replace(/^\.\//, '');
  if (trimmed.includes('/')) return trimmed;
  const withExt = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
  return `${PLANS_DIR}/${withExt}`;
}

/** The five default markdown source sets, tagged by source class. */
function defaultSources(factsDir: string): SourceSet[] {
  return [
    { sourceClass: 'design', include: ['design/**/*.md'] },
    { sourceClass: 'docs', include: ['docs/**/*.md'] },
    // Plans/decisions/bugs already live as frontmatter markdown here, which is
    // also how they project into tracker items (fm:<type>:<path>), so indexing
    // these globs already grounds the agent in tracker content for v1.
    { sourceClass: 'plans', include: ['nimbalyst-local/plans/**/*.md'] },
    { sourceClass: 'claude', include: ['CLAUDE.md', '**/CLAUDE.md'] },
    { sourceClass: 'facts', include: [`${factsDir}/**/*.md`] },
  ];
}

/**
 * Tool descriptors advertised to the host. `name` doubles as the RPC method
 * name. Schemas mirror engine/src/mcp/server.ts. Voice-flagged tools are the
 * conversational essentials; the rest stay coding-agent-only.
 */
const TOOL_DESCRIPTORS = [
  {
    name: 'search_project_knowledge',
    description:
      'Hybrid semantic + keyword search over the indexed project markdown ' +
      '(design docs, plans, CLAUDE.md, trackers, voice-memory). Returns the top ' +
      'matching chunks with source + heading citations. Use this to ground ' +
      'answers in how the project actually works.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        k: { type: 'number', description: 'Max results (default 5).' },
      },
      required: ['query'],
    },
    voiceAgent: true,
  },
  {
    name: 'recall',
    description:
      'Recall stored facts, optionally filtered by category/scope and ranked by a ' +
      'query. Newest wins when facts conflict.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    voiceAgent: true,
  },
  {
    name: 'remember',
    description:
      'Append a durable fact to memory (ADD-only; never overwrites). Use for ' +
      'preferences, decisions, and project truths worth recalling later.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        category: { type: 'string' },
        scope: { type: 'string' },
        priority: { type: 'number', description: 'Higher = injected sooner at start.' },
      },
      required: ['text'],
    },
    voiceAgent: true,
  },
  {
    name: 'expand',
    description:
      'Expand a search hit to its full heading section. Pass the sourcePath and ' +
      'headingPath from a search_project_knowledge result.',
    inputSchema: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string' },
        headingPath: { type: 'array', items: { type: 'string' } },
      },
      required: ['sourcePath'],
    },
    voiceAgent: false,
  },
  {
    name: 'read_doc',
    description: 'Read a managed document by its relative path (e.g. a plan file).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    voiceAgent: false,
  },
  {
    name: 'get_latest_plan',
    description:
      'Read back the most recently edited plan document so you can summarize it ' +
      'aloud. Use this right after kicking off a /design task and being told it ' +
      'finished, or when the user asks "read me the plan" / "what does the plan ' +
      'say". Returns the plan path and its markdown body.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: true,
  },
  {
    name: 'read_plan',
    description:
      'Read a specific plan document by name or relative path so you can ' +
      'summarize or discuss it aloud. Accepts a bare plan name (e.g. ' +
      '"voice-agent-grounding-system") or a full relative path. Returns the ' +
      'plan path and its markdown body.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Plan name or root-relative path to the plan markdown.',
        },
      },
      required: ['path'],
    },
    voiceAgent: true,
  },
  {
    name: 'status',
    description: 'Report index size, the active embedder, and whether a re-index is needed.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: false,
  },
  {
    name: 'list_facts',
    description:
      'List the durable facts currently stored in memory (the voice-memory ' +
      'markdown tree), newest/highest-priority first. Returns each fact with its ' +
      'sourcePath, text, category, scope, and priority. Used by the settings ' +
      'facts viewer.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max facts (default 200).' } },
    },
    voiceAgent: false,
  },
  {
    name: 'delete_fact',
    description:
      'Delete a stored fact by its sourcePath (as returned by list_facts). ' +
      'Removes the underlying markdown file; the chunks are pruned on the next ' +
      'index pass.',
    inputSchema: {
      type: 'object',
      properties: { sourcePath: { type: 'string' } },
      required: ['sourcePath'],
    },
    voiceAgent: false,
  },
  {
    name: 'rebuild',
    description:
      'Force a full re-index of the project markdown. Re-walks the sources, ' +
      're-chunks changed files, and refreshes the retrieval snapshot. Returns the ' +
      'number of chunks indexed and files seen.',
    inputSchema: { type: 'object', properties: {} },
    voiceAgent: false,
  },
  {
    name: 'distill_candidate_facts',
    description:
      'Auto-distill CANDIDATE durable facts from the most recent project ' +
      'documents (decisions/plans by default) using an LLM extraction pass. ' +
      'Returns proposed facts WITHOUT storing them — the user confirms which to ' +
      'keep, then they are added via remember (ADD-only). Used by the settings ' +
      'facts viewer to seed memory from real project decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceClass: {
          type: 'string',
          description: "Source class to harvest (default 'plans'; e.g. 'design', 'docs').",
        },
        maxDocs: { type: 'number', description: 'How many recent docs to scan (default 3).' },
      },
    },
    voiceAgent: false,
  },
] as const;

export async function activate(ctx: ActivateCtx) {
  const { workspacePath, dataDir, log, getApiKey, registerMcpTools } = ctx.services;

  // The index (db/wal/shm) is machine-local, rebuildable state — never source.
  // It lives in the host-provided per-workspace userData dir so it stays out of
  // the user's project tree entirely.
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'index.db');

  const config: EngineConfig = {
    root: workspacePath,
    dbPath,
    factsDir: FACTS_DIR,
    sources: defaultSources(FACTS_DIR),
    // Keep stale/archived markdown out of the index so retrieval surfaces
    // current truth, not abandoned plans (e.g. nimbalyst-local/plans/archive/**
    // duplicating live design docs).
    exclude: ['**/archive/**'],
    // Surface engine-internal warnings (e.g. a failed query embedding that
    // would otherwise silently degrade search to sparse-only) into the host log.
    onLog: (level, message) => log(level, message),
  };

  // Build the engine if (and only if) we have a key. OpenAIEmbedder throws on a
  // missing key at construction, so we guard the methods instead of crashing
  // activate — the tools register either way and report the missing key.
  let engine: MemoryEngine | null = null;
  let startupError: string | null = null;
  try {
    const { key } = await getApiKey('openai');
    if (!key) {
      startupError =
        'OpenAI API key not configured. Add an OpenAI key in Nimbalyst AI settings, then re-enable this extension.';
      log('warn', `[memory] ${startupError}`);
    } else {
      const embedder = await createEmbedder({ kind: 'openai', apiKey: key });
      engine = MemoryEngine.create(config, embedder);
      log('info', `[memory] engine ready: root=${config.root} db=${config.dbPath}`);

      // Background initial index + live watch. Never blocks activation; the
      // tools serve a partial/empty index until the first pass completes.
      void (async () => {
        try {
          const status = engine!.status();
          if (status.embedderChanged) log('info', '[memory] embedder changed — full re-index');
          const result = await engine!.indexAll();
          log('info', `[memory] indexed ${result.indexed} chunk(s) across ${result.files} file(s)`);
          engine!.startWatching();
          log('info', '[memory] watching for changes');
        } catch (err) {
          log('error', `[memory] initial index failed: ${(err as Error).message}`);
        }
      })();
    }
  } catch (err) {
    startupError = (err as Error).message;
    log('error', `[memory] engine init failed: ${startupError}`);
  }

  function requireEngine(): MemoryEngine {
    if (!engine) {
      throw new Error(startupError ?? 'Memory engine is not ready.');
    }
    return engine;
  }

  await registerMcpTools(
    TOOL_DESCRIPTORS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      voiceAgent: t.voiceAgent,
      scope: 'global' as const,
    }))
  );

  return {
    methods: {
      search_project_knowledge: async (params: { query?: string; k?: number }) => {
        const query = String(params?.query ?? '');
        if (!query) throw new Error('query is required');
        const k = typeof params?.k === 'number' ? params.k : 5;
        return { chunks: await requireEngine().search(query, k) };
      },

      recall: async (params: { query?: string; category?: string; scope?: string; limit?: number }) => {
        return {
          facts: await requireEngine().recall({
            query: params?.query != null ? String(params.query) : undefined,
            category: params?.category != null ? String(params.category) : undefined,
            scope: params?.scope != null ? String(params.scope) : undefined,
            limit: typeof params?.limit === 'number' ? params.limit : undefined,
          }),
        };
      },

      remember: async (params: {
        text?: string;
        category?: string;
        scope?: string;
        priority?: number;
      }) => {
        const text = String(params?.text ?? '');
        if (!text) throw new Error('text is required');
        const written = await requireEngine().remember({
          text,
          category: params?.category != null ? String(params.category) : null,
          scope: params?.scope != null ? String(params.scope) : null,
          priority: typeof params?.priority === 'number' ? params.priority : 0,
        });
        return { ok: true, path: written };
      },

      expand: async (params: { sourcePath?: string; headingPath?: unknown[] }) => {
        const sourcePath = String(params?.sourcePath ?? '');
        if (!sourcePath) throw new Error('sourcePath is required');
        const headingPath = Array.isArray(params?.headingPath)
          ? params.headingPath.map(String)
          : [];
        return requireEngine().expand(sourcePath, headingPath);
      },

      read_doc: async (params: { path?: string }) => {
        const p = String(params?.path ?? '');
        if (!p) throw new Error('path is required');
        return requireEngine().readDoc(p);
      },

      get_latest_plan: async () => {
        const latest = await requireEngine().latestDoc('plans');
        if (!latest) {
          return { found: false, message: 'No plan documents found in this project yet.' };
        }
        const { content, truncated } = capForVoice(latest.content);
        return { found: true, path: latest.path, content, truncated };
      },

      read_plan: async (params: { path?: string }) => {
        const ref = String(params?.path ?? '');
        if (!ref) throw new Error('path is required');
        const relPath = resolvePlanPath(ref);
        const doc = await requireEngine().readDoc(relPath);
        const { content, truncated } = capForVoice(doc.content);
        return { found: true, path: doc.path, content, truncated };
      },

      status: async () => {
        if (!engine) {
          return { ready: false, error: startupError, root: config.root };
        }
        return { ready: true, ...engine.status(), indexSizeBytes: await engine.indexSizeBytes() };
      },

      list_facts: async (params: { limit?: number }) => {
        const limit = typeof params?.limit === 'number' ? params.limit : 200;
        return { facts: await requireEngine().recall({ limit }) };
      },

      delete_fact: async (params: { sourcePath?: string }) => {
        const sourcePath = String(params?.sourcePath ?? '');
        if (!sourcePath) throw new Error('sourcePath is required');
        const deleted = await requireEngine().deleteFact(sourcePath);
        return { deleted };
      },

      rebuild: async () => {
        const result = await requireEngine().indexAll();
        log('info', `[memory] rebuild: indexed ${result.indexed} chunk(s) across ${result.files} file(s)`);
        return { ok: true, ...result };
      },

      distill_candidate_facts: async (params: { sourceClass?: string; maxDocs?: number }) => {
        const eng = requireEngine();
        const sourceClass = params?.sourceClass ? String(params.sourceClass) : 'plans';
        const maxDocs = typeof params?.maxDocs === 'number' ? params.maxDocs : 3;

        const { key } = await getApiKey('openai');
        if (!key) {
          throw new Error('OpenAI API key not configured. Add one in Nimbalyst AI settings.');
        }

        const docs = await eng.recentDocs(sourceClass, maxDocs);
        if (docs.length === 0) {
          return { candidates: [] as FactCandidate[], sources: [], sourceClass };
        }

        const existing = (await eng.recall({ limit: 500 })).map((f) => f.text);
        const messages = buildDistillMessages(docs.map((d) => ({ path: d.path, content: d.content })));
        const responseText = await chatComplete(messages, key);
        const candidates = parseDistillResponse(responseText, existing);
        const sources = docs.map((d) => d.path);
        log('info', `[memory] distilled ${candidates.length} candidate fact(s) from ${sources.length} ${sourceClass} doc(s)`);
        return { candidates, sources, sourceClass };
      },
    },

    deactivate: async () => {
      await engine?.close();
    },
  };
}
