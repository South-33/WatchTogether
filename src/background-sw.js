'use strict';

const OFFSCREEN_PATH = 'offscreen.html';
const DEFAULT_CONVEX_URL = import.meta.env.VITE_CONVEX_URL || '';
const DEFAULT_STATE = {
    clientId: null,
    convexUrl: DEFAULT_CONVEX_URL,
    sessionId: null,
    sessionCode: null,
    role: null,
    connected: false,
    autoSync: true,
    autoPaused: false,
    activeTabId: null,
    activeTabUrl: '',
    lastLeaderState: null,
    localState: null,
    participants: [],
    resyncRequestedAt: null,
    resyncRequestedBy: null,
    error: null
};

let state = { ...DEFAULT_STATE };
let creatingOffscreen = null;
let persistTimer = null;
let lastLocalStateWriteAt = 0;
let lastAutoOpenSessionId = null;

bootstrap().catch(function (error) {
    console.error(error);
});

chrome.runtime.onInstalled.addListener(function () {
    resetSessionState();
});

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    handleMessage(message, sender)
        .then(function (result) {
            sendResponse({ ok: true, data: result });
        })
        .catch(function (error) {
            console.error(error);
            sendResponse({ ok: false, error: String(error) });
        });
    return true;
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (state.activeTabId === tabId && changeInfo.status === 'complete') {
        injectContentScript(tabId);
    }
});

async function bootstrap() {
    const stored = await storageGet(DEFAULT_STATE);
    state = { ...DEFAULT_STATE, ...stored };
    if (!state.clientId) {
        state.clientId = crypto.randomUUID();
        schedulePersist();
    }
    if (!state.convexUrl && DEFAULT_CONVEX_URL) {
        state.convexUrl = DEFAULT_CONVEX_URL;
        schedulePersist();
    }

    if (state.sessionCode && state.clientId && state.convexUrl) {
        state = {
            ...state,
            connected: false,
            role: null,
            sessionId: null,
            participants: [],
            lastLeaderState: null,
            resyncRequestedAt: null,
            resyncRequestedBy: null,
            error: null
        };
        schedulePersist();
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'joinSession',
            clientId: state.clientId,
            convexUrl: state.convexUrl,
            code: state.sessionCode
        });
    }
}

async function handleMessage(message, sender) {
    if (!message) {
        return;
    }

    if (message.source === 'offscreen') {
        handleOffscreenEvent(message);
        return;
    }

    switch (message.action) {
        case 'ui:getStatus':
            return state;
        case 'ui:setConvexUrl':
            state.convexUrl = message.convexUrl || '';
            schedulePersist();
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'setConvexUrl',
                convexUrl: state.convexUrl
            });
            return;
        case 'ui:createSession':
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'createSession',
                clientId: state.clientId,
                autoSync: state.autoSync,
                convexUrl: state.convexUrl,
                url: state.activeTabUrl || ''
            });
            return;
        case 'ui:joinSession':
            if (!message.code) {
                return;
            }
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'joinSession',
                clientId: state.clientId,
                convexUrl: state.convexUrl,
                code: message.code
            });
            return;
        case 'ui:leaveSession':
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'leaveSession'
            });
            resetSessionState();
            return;
        case 'ui:activateTab':
            await activateCurrentTab();
            return;
        case 'ui:toggleAutoSync':
            state.autoSync = Boolean(message.autoSync);
            schedulePersist();
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'setAutoSync',
                autoSync: state.autoSync
            });
            return;
        case 'ui:resyncNow':
            sendToActiveContent({ action: 'forceSync' });
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'clearResyncRequest'
            });
            return;
        case 'ui:requestResync':
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'requestResync'
            });
            return;
        case 'content:register':
            if (sender && sender.tab && sender.tab.id !== undefined) {
                state.activeTabId = sender.tab.id;
                if (sender.tab.url) {
                    state.activeTabUrl = sender.tab.url;
                }
                schedulePersist();
            }
            return;
        case 'content:leaderState':
            if (!state.sessionId || state.role !== 'leader') {
                return;
            }
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'updateLeaderState',
                url: message.url || '',
                state: message.state,
                position: message.position,
                playbackRate: message.playbackRate
            });
            return;
        case 'content:participantStatus':
            if (!state.sessionId) {
                return;
            }
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'updateParticipantStatus',
                buffering: Boolean(message.buffering),
                lastPosition: message.lastPosition
            });
            return;
        case 'content:localState':
            state.localState = message.localState || null;
            throttledPersist();
            return;
        default:
            return;
    }
}

function handleOffscreenEvent(message) {
    if (message.type === 'sessionUpdate') {
        const session = message.session;
        const participants = message.participants || [];

        state.sessionId = session ? session._id : null;
        state.sessionCode = session ? session.code : null;
        state.connected = Boolean(session);
        state.participants = participants;
        state.lastLeaderState = session
            ? {
                url: session.url,
                state: session.state,
                position: session.position,
                playbackRate: session.playbackRate,
                serverTs: session.serverTs
            }
            : null;
        state.autoSync = session ? session.autoSync : state.autoSync;
        state.autoPaused = session ? session.autoPaused : false;
        state.resyncRequestedAt = session ? session.resyncRequestedAt || null : null;
        state.resyncRequestedBy = session ? session.resyncRequestedBy || null : null;
        state.role = session
            ? session.leaderId === state.clientId
                ? 'leader'
                : 'follower'
            : null;
        state.error = null;
        schedulePersist();

        if (state.role === 'follower' && session) {
            deliverVideoState(session);
        }

        if (state.role === 'follower' && session && session.url && state.sessionId) {
            if (lastAutoOpenSessionId !== state.sessionId) {
                lastAutoOpenSessionId = state.sessionId;
                openFollowerTab(session.url);
            }
        }
    } else if (message.type === 'command') {
        if (message.command === 'autoPause') {
            sendToActiveContent({ action: 'autoPause' });
        } else if (message.command === 'autoResume') {
            sendToActiveContent({ action: 'autoResume' });
        }
    } else if (message.type === 'error') {
        state.error = message.error || 'Unknown error';
        schedulePersist();
    }
}

function resetSessionState() {
    state = {
        ...state,
        sessionId: null,
        sessionCode: null,
        role: null,
        connected: false,
        autoPaused: false,
        lastLeaderState: null,
        participants: [],
        resyncRequestedAt: null,
        resyncRequestedBy: null,
        error: null
    };
    schedulePersist();
}

async function activateCurrentTab() {
    const tabs = await tabsQuery({ active: true, currentWindow: true });
    if (!tabs || !tabs.length) {
        return;
    }
    const tab = tabs[0];
    state.activeTabId = tab.id || null;
    state.activeTabUrl = tab.url || '';
    schedulePersist();
    if (state.activeTabId !== null) {
        injectContentScript(state.activeTabId);
    }
    if (state.role === 'leader' && state.activeTabUrl) {
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'setSessionUrl',
            url: state.activeTabUrl
        });
    }
}

function openFollowerTab(url) {
    chrome.tabs.create({ url }, function (tab) {
        if (!tab || tab.id === undefined) {
            return;
        }
        state.activeTabId = tab.id;
        state.activeTabUrl = tab.url || url;
        schedulePersist();
        injectContentScript(tab.id);
    });
}

function injectContentScript(tabId) {
    chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ['content.js']
    }, function () {
        if (chrome.runtime.lastError) {
            console.log(chrome.runtime.lastError);
        }
    });
}

function deliverVideoState(session) {
    const payload = {
        action: 'applyState',
        content: {
            url: session.url,
            state: session.state,
            position: session.position,
            playbackRate: session.playbackRate,
            serverTs: session.serverTs
        }
    };

    sendToActiveContent(payload);
}

function sendToActiveContent(payload) {
    if (state.activeTabId !== null) {
        chrome.tabs.sendMessage(state.activeTabId, payload, function () {
            if (chrome.runtime.lastError) {
                console.log(chrome.runtime.lastError);
            }
        });
        return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs || tabs.length === 0 || tabs[0].id === undefined) {
            return;
        }
        chrome.tabs.sendMessage(tabs[0].id, payload, function () {
            if (chrome.runtime.lastError) {
                console.log(chrome.runtime.lastError);
            }
        });
    });
}

async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) {
        return;
    }

    if (!creatingOffscreen) {
        creatingOffscreen = chrome.offscreen.createDocument({
            url: OFFSCREEN_PATH,
            reasons: ['IFRAME_SCRIPTING'],
            justification: 'Keep realtime Convex subscriptions alive for session sync.'
        });
    }

    await creatingOffscreen;
    creatingOffscreen = null;
}

async function hasOffscreenDocument() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);

    if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });
        return contexts.length > 0;
    }

    if (chrome.offscreen && chrome.offscreen.hasDocument) {
        return await chrome.offscreen.hasDocument();
    }

    return false;
}

function schedulePersist() {
    if (persistTimer) {
        return;
    }
    persistTimer = setTimeout(function () {
        persistTimer = null;
        storageSet(state).catch(function (error) {
            console.error(error);
        });
    }, 200);
}

function throttledPersist() {
    const now = Date.now();
    if (now - lastLocalStateWriteAt < 500) {
        return;
    }
    lastLocalStateWriteAt = now;
    schedulePersist();
}

function storageGet(defaults) {
    return new Promise(function (resolve, reject) {
        chrome.storage.local.get(defaults, function (result) {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            resolve(result);
        });
    });
}

function storageSet(values) {
    return new Promise(function (resolve, reject) {
        chrome.storage.local.set(values, function () {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            resolve();
        });
    });
}

function tabsQuery(queryInfo) {
    return new Promise(function (resolve) {
        chrome.tabs.query(queryInfo, function (tabs) {
            resolve(tabs);
        });
    });
}
