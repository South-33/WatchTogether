import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  sessions: defineTable({
    code: v.string(),
    leaderId: v.string(),
    url: v.string(),
    state: v.union(v.literal('playing'), v.literal('paused')),
    position: v.number(),
    playbackRate: v.number(),
    serverTs: v.number(),
    autoSync: v.boolean(),
    autoPaused: v.boolean(),
    resyncRequestedAt: v.optional(v.number()),
    resyncRequestedBy: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number()
  })
    .index('by_code', ['code'])
    .index('by_expires', ['expiresAt']),
  participants: defineTable({
    sessionId: v.id('sessions'),
    clientId: v.string(),
    role: v.union(v.literal('leader'), v.literal('follower')),
    buffering: v.boolean(),
    lastPosition: v.number(),
    lastSeenAt: v.number()
  })
    .index('by_session', ['sessionId'])
    .index('by_session_client', ['sessionId', 'clientId'])
});
