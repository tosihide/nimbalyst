import { describe, expect, it, vi, beforeEach } from 'vitest';

// The real module pulls in WindowManager (electron) and the runtime repository
// at load; stub both so the title-resolution logic can be tested in node.
const findWindowByWorkspace = vi.fn();
vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: (...a: any[]) => findWindowByWorkspace(...a),
}));

const list = vi.fn();
vi.mock('@nimbalyst/runtime', () => ({
  AISessionsRepository: { list: (...a: any[]) => list(...a) },
}));

import { getSessionSummaryForVoice } from '../sessionSummary';

const WS = '/ws';
const SESSION = {
  title: 'Design real-time collaborative trackers',
  messages: [
    { type: 'user_message', text: 'Lets design the sync layer' },
    { type: 'assistant_message', text: 'Here is the plan' },
  ],
  createdAt: Date.now() - 60000,
};

/** A fake window whose executeJavaScript resolves ai:loadSession by id. */
function makeWindow(sessionsById: Record<string, any>) {
  return {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: vi.fn(async (code: string) => {
        // The first JSON.stringify argument in the snippet is the session id.
        const match = code.match(/'ai:loadSession',\s*("(?:[^"\\]|\\.)*")/);
        const id = match ? JSON.parse(match[1]) : '';
        return sessionsById[id] ?? null;
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue([]);
});

describe('getSessionSummaryForVoice', () => {
  it('summarizes a session loaded directly by id', async () => {
    findWindowByWorkspace.mockReturnValue(makeWindow({ 'sess-1': SESSION }));

    const out = await getSessionSummaryForVoice(WS, 'sess-1');

    expect(out.success).toBe(true);
    expect(out.details?.sessionId).toBe('sess-1');
    expect(out.summary).toContain('Design real-time collaborative trackers');
  });

  it('falls back to resolving a session TITLE the voice model passed as session_id', async () => {
    // loadSession only knows the real id; the title is not a valid id.
    findWindowByWorkspace.mockReturnValue(makeWindow({ 'sess-1': SESSION }));
    list.mockResolvedValue([
      { id: 'sess-1', title: 'Design real-time collaborative trackers' },
      { id: 'sess-2', title: 'Something else' },
    ]);

    const out = await getSessionSummaryForVoice(
      WS,
      'Design real-time collaborative trackers',
    );

    expect(out.success).toBe(true);
    // The resolved id, not the title, is reported back.
    expect(out.details?.sessionId).toBe('sess-1');
    expect(list).toHaveBeenCalledWith(WS);
  });

  it('returns "Session not found" when neither id nor title matches', async () => {
    findWindowByWorkspace.mockReturnValue(makeWindow({ 'sess-1': SESSION }));
    list.mockResolvedValue([{ id: 'sess-1', title: 'Design real-time collaborative trackers' }]);

    const out = await getSessionSummaryForVoice(WS, 'No such session');

    expect(out.success).toBe(false);
    expect(out.error).toBe('Session not found');
  });
});
