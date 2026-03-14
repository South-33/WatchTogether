import { mutation, query, internalMutation } from './_generated/server';
import { v } from 'convex/values';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_PARTICIPANT_MS = 5 * 60 * 1000;

function nowMs() {
  return Date.now();
}

function randomCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return result;
}

async function generateUniqueCode(ctx: { db: any }) {
  for (let i = 0; i < 10; i += 1) {
    const candidate = randomCode();
    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_code', (q: any) => q.eq('code', candidate))
      .unique();
    if (!existing) {
      return candidate;
    }
  }
  throw new Error('Failed to generate session code.');
}

export const createSession = mutation({
  args: {
    leaderId: v.string(),
    url: v.string(),
    autoSync: v.boolean()
  },
  handler: async (ctx, args) => {
    const now = nowMs();
    const code = await generateUniqueCode(ctx);

    const sessionId = await ctx.db.insert('sessions', {
      code,
      leaderId: args.leaderId,
      url: args.url,
      state: 'paused',
      position: 0,
      playbackRate: 1,
      serverTs: now,
      autoSync: args.autoSync,
      autoPaused: false,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });

    await ctx.db.insert('participants', {
      sessionId,
      clientId: args.leaderId,
      role: 'leader',
      buffering: false,
      lastPosition: 0,
      lastSeenAt: now
    });

    const session = await ctx.db.get('sessions', sessionId);
    if (!session) {
      throw new Error('Session creation failed.');
    }
    return session;
  }
});

export const joinSession = mutation({
  args: {
    code: v.string(),
    clientId: v.string()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();

    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.expiresAt < nowMs()) {
      throw new Error('Session expired.');
    }

    const existing = await ctx.db
      .query('participants')
      .withIndex('by_session_client', (q) =>
        q.eq('sessionId', session._id).eq('clientId', args.clientId)
      )
      .unique();

    const now = nowMs();
    const role = session.leaderId === args.clientId ? 'leader' : 'follower';
    await ctx.db.patch('sessions', session._id, { expiresAt: now + SESSION_TTL_MS });
    if (existing) {
      await ctx.db.patch('participants', existing._id, {
        role,
        buffering: false,
        lastSeenAt: now
      });
    } else {
      await ctx.db.insert('participants', {
        sessionId: session._id,
        clientId: args.clientId,
        role,
        buffering: false,
        lastPosition: 0,
        lastSeenAt: now
      });
    }

    return session;
  }
});

export const leaveSession = mutation({
  args: {
    sessionId: v.id('sessions'),
    clientId: v.string()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      return;
    }

    if (session.leaderId === args.clientId) {
      const participants = await ctx.db
        .query('participants')
        .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
        .collect();
      for (const participant of participants) {
        await ctx.db.delete('participants', participant._id);
      }
      await ctx.db.delete('sessions', args.sessionId);
      return;
    }

    const existing = await ctx.db
      .query('participants')
      .withIndex('by_session_client', (q) =>
        q.eq('sessionId', args.sessionId).eq('clientId', args.clientId)
      )
      .unique();
    if (existing) {
      await ctx.db.delete('participants', existing._id);
    }
  }
});

export const updateLeaderState = mutation({
  args: {
    sessionId: v.id('sessions'),
    leaderId: v.string(),
    url: v.string(),
    state: v.union(v.literal('playing'), v.literal('paused')),
    position: v.number(),
    playbackRate: v.number()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.leaderId !== args.leaderId) {
      throw new Error('Not session leader.');
    }

    const now = nowMs();
    await ctx.db.patch('sessions', args.sessionId, {
      url: args.url || session.url,
      state: args.state,
      position: args.position,
      playbackRate: args.playbackRate,
      serverTs: now,
      expiresAt: now + SESSION_TTL_MS
    });

    const leader = await ctx.db
      .query('participants')
      .withIndex('by_session_client', (q) =>
        q.eq('sessionId', args.sessionId).eq('clientId', args.leaderId)
      )
      .unique();
    if (leader) {
      await ctx.db.patch('participants', leader._id, {
        buffering: false,
        lastPosition: args.position,
        lastSeenAt: now
      });
    }
  }
});

export const setSessionUrl = mutation({
  args: {
    sessionId: v.id('sessions'),
    leaderId: v.string(),
    url: v.string()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.leaderId !== args.leaderId) {
      throw new Error('Not session leader.');
    }
    const now = nowMs();
    await ctx.db.patch('sessions', args.sessionId, {
      url: args.url || session.url,
      expiresAt: now + SESSION_TTL_MS
    });
  }
});

export const updateParticipantStatus = mutation({
  args: {
    sessionId: v.id('sessions'),
    clientId: v.string(),
    buffering: v.boolean(),
    lastPosition: v.number()
  },
  handler: async (ctx, args) => {
    const now = nowMs();
    const existing = await ctx.db
      .query('participants')
      .withIndex('by_session_client', (q) =>
        q.eq('sessionId', args.sessionId).eq('clientId', args.clientId)
      )
      .unique();

    if (existing) {
      await ctx.db.patch('participants', existing._id, {
        buffering: args.buffering,
        lastPosition: args.lastPosition,
        lastSeenAt: now
      });
      return;
    }

    await ctx.db.insert('participants', {
      sessionId: args.sessionId,
      clientId: args.clientId,
      role: 'follower',
      buffering: args.buffering,
      lastPosition: args.lastPosition,
      lastSeenAt: now
    });
  }
});

export const setAutoSync = mutation({
  args: {
    sessionId: v.id('sessions'),
    leaderId: v.string(),
    autoSync: v.boolean()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.leaderId !== args.leaderId) {
      throw new Error('Not session leader.');
    }
    await ctx.db.patch('sessions', args.sessionId, {
      autoSync: args.autoSync
    });
  }
});

export const setAutoPaused = mutation({
  args: {
    sessionId: v.id('sessions'),
    leaderId: v.string(),
    autoPaused: v.boolean()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.leaderId !== args.leaderId) {
      throw new Error('Not session leader.');
    }
    await ctx.db.patch('sessions', args.sessionId, {
      autoPaused: args.autoPaused
    });
  }
});

export const requestResync = mutation({
  args: {
    sessionId: v.id('sessions'),
    clientId: v.string()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    await ctx.db.patch('sessions', args.sessionId, {
      resyncRequestedAt: nowMs(),
      resyncRequestedBy: args.clientId
    });
  }
});

export const clearResyncRequest = mutation({
  args: {
    sessionId: v.id('sessions'),
    leaderId: v.string()
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session) {
      throw new Error('Session not found.');
    }
    if (session.leaderId !== args.leaderId) {
      throw new Error('Not session leader.');
    }
    await ctx.db.patch('sessions', args.sessionId, {
      resyncRequestedAt: undefined,
      resyncRequestedBy: undefined
    });
  }
});

export const getSessionByCode = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_code', (q) => q.eq('code', args.code))
      .unique();
    if (!session || session.expiresAt < nowMs()) {
      return null;
    }
    return session;
  }
});

export const getSessionState = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId);
    if (!session || session.expiresAt < nowMs()) {
      return null;
    }
    return session;
  }
});

export const listParticipants = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, args) => {
    const now = nowMs();
    const participants = await ctx.db
      .query('participants')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    return participants.filter((participant) => now - participant.lastSeenAt < STALE_PARTICIPANT_MS);
  }
});

export const cleanupExpiredSessions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = nowMs();
    const expired = await ctx.db
      .query('sessions')
      .withIndex('by_expires', (q) => q.lt('expiresAt', now))
      .collect();
    for (const session of expired) {
      const participants = await ctx.db
        .query('participants')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .collect();
      for (const participant of participants) {
        await ctx.db.delete('participants', participant._id);
      }
      await ctx.db.delete('sessions', session._id);
    }
  }
});
