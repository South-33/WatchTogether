'use strict';

import { ConvexClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

const DEFAULT_CONVEX_URL = import.meta.env.VITE_CONVEX_URL || '';

let convexClient = null;
let convexUrl = DEFAULT_CONVEX_URL;
let clientId = '';
let sessionId = null;
let role = null;
let sessionSub = null;
let participantsSub = null;
let sessionState = null;
let participantState = [];
let lastAutoActionAt = 0;
let pendingAutoAction = null;

chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.target !== 'offscreen') {
        return;
    }

    handleMessage(message).catch(function (error) {
        sendError(String(error));
    });
});

async function handleMessage(message) {
    if (message.action === 'setConvexUrl') {
        if (message.convexUrl && message.convexUrl !== convexUrl) {
            convexUrl = message.convexUrl;
            resetClient();
        }
        return;
    }

    if (message.action === 'createSession') {
        clientId = message.clientId || clientId;
        convexUrl = message.convexUrl || convexUrl;
        ensureClient();
        const session = await convexClient.mutation(api.sessions.createSession, {
            leaderId: clientId,
            url: message.url || '',
            autoSync: message.autoSync !== false
        });
        role = 'leader';
        sessionId = session._id;
        subscribeToSession();
        return;
    }

    if (message.action === 'joinSession') {
        clientId = message.clientId || clientId;
        convexUrl = message.convexUrl || convexUrl;
        ensureClient();
        const session = await convexClient.mutation(api.sessions.joinSession, {
            code: message.code,
            clientId: clientId
        });
        role = 'follower';
        sessionId = session._id;
        subscribeToSession();
        return;
    }

    if (message.action === 'leaveSession') {
        if (!sessionId) {
            return;
        }
        await convexClient.mutation(api.sessions.leaveSession, {
            sessionId,
            clientId
        });
        cleanupSession();
        return;
    }

    if (message.action === 'updateLeaderState') {
        if (!sessionId || role !== 'leader') {
            return;
        }
        await convexClient.mutation(api.sessions.updateLeaderState, {
            sessionId,
            leaderId: clientId,
            url: message.url || '',
            state: message.state,
            position: message.position,
            playbackRate: message.playbackRate
        });
        return;
    }

    if (message.action === 'setSessionUrl') {
        if (!sessionId || role !== 'leader') {
            return;
        }
        await convexClient.mutation(api.sessions.setSessionUrl, {
            sessionId,
            leaderId: clientId,
            url: message.url || ''
        });
        return;
    }

    if (message.action === 'updateParticipantStatus') {
        if (!sessionId) {
            return;
        }
        await convexClient.mutation(api.sessions.updateParticipantStatus, {
            sessionId,
            clientId,
            buffering: Boolean(message.buffering),
            lastPosition: message.lastPosition
        });
        return;
    }

    if (message.action === 'setAutoSync') {
        if (!sessionId) {
            return;
        }
        await convexClient.mutation(api.sessions.setAutoSync, {
            sessionId,
            leaderId: clientId,
            autoSync: Boolean(message.autoSync)
        });
        return;
    }

    if (message.action === 'requestResync') {
        if (!sessionId) {
            return;
        }
        await convexClient.mutation(api.sessions.requestResync, {
            sessionId,
            clientId
        });
        return;
    }

    if (message.action === 'clearResyncRequest') {
        if (!sessionId) {
            return;
        }
        await convexClient.mutation(api.sessions.clearResyncRequest, {
            sessionId,
            leaderId: clientId
        });
        return;
    }
}

function ensureClient() {
    if (!convexUrl) {
        throw new Error('Missing Convex URL. Set it in the extension settings.');
    }

    if (!convexClient) {
        convexClient = new ConvexClient(convexUrl);
    }
}

function resetClient() {
    cleanupSession();
    if (convexClient && typeof convexClient.close === 'function') {
        convexClient.close();
    }
    convexClient = null;
}

function cleanupSession() {
    if (sessionSub) {
        sessionSub();
    }
    if (participantsSub) {
        participantsSub();
    }
    sessionSub = null;
    participantsSub = null;
    sessionState = null;
    participantState = [];
    sessionId = null;
    role = null;
    pendingAutoAction = null;
    lastAutoActionAt = 0;
    chrome.runtime.sendMessage({
        source: 'offscreen',
        type: 'sessionUpdate',
        session: null,
        participants: []
    });
}

function subscribeToSession() {
    if (!sessionId) {
        return;
    }
    if (sessionSub) {
        sessionSub();
    }
    if (participantsSub) {
        participantsSub();
    }

    sessionSub = convexClient.onUpdate(
        api.sessions.getSessionState,
        { sessionId },
        function (session) {
            sessionState = session;
            emitState();
        }
    );

    participantsSub = convexClient.onUpdate(
        api.sessions.listParticipants,
        { sessionId },
        function (participants) {
            participantState = participants;
            emitState();
        }
    );
}

function emitState() {
    chrome.runtime.sendMessage({
        source: 'offscreen',
        type: 'sessionUpdate',
        session: sessionState,
        participants: participantState
    });

    if (sessionState) {
        maybeAutoAdjust();
    }
}

function maybeAutoAdjust() {
    if (!sessionState || !participantState.length) {
        return;
    }
    if (sessionState.leaderId !== clientId) {
        return;
    }
    if (!sessionState.autoSync) {
        return;
    }

    const now = Date.now();
    if (now - lastAutoActionAt < 1500) {
        return;
    }

    if (sessionState.autoPaused && sessionState.state === 'playing') {
        convexClient.mutation(api.sessions.setAutoPaused, {
            sessionId,
            leaderId: clientId,
            autoPaused: false
        }).catch(function () { });
        return;
    }

    const anyBuffering = participantState.some(function (participant) {
        return participant.role === 'follower' && participant.buffering;
    });

    if (anyBuffering && sessionState.state === 'playing' && !sessionState.autoPaused) {
        if (pendingAutoAction !== 'pause') {
            pendingAutoAction = 'pause';
            lastAutoActionAt = now;
            convexClient.mutation(api.sessions.setAutoPaused, {
                sessionId,
                leaderId: clientId,
                autoPaused: true
            }).catch(function () { });
            chrome.runtime.sendMessage({
                source: 'offscreen',
                type: 'command',
                command: 'autoPause'
            });
        }
    } else if (!anyBuffering && sessionState.state === 'paused' && sessionState.autoPaused) {
        if (pendingAutoAction !== 'resume') {
            pendingAutoAction = 'resume';
            lastAutoActionAt = now;
            convexClient.mutation(api.sessions.setAutoPaused, {
                sessionId,
                leaderId: clientId,
                autoPaused: false
            }).catch(function () { });
            chrome.runtime.sendMessage({
                source: 'offscreen',
                type: 'command',
                command: 'autoResume'
            });
        }
    } else {
        pendingAutoAction = null;
    }
}

function sendError(message) {
    chrome.runtime.sendMessage({
        source: 'offscreen',
        type: 'error',
        error: message
    });
}
