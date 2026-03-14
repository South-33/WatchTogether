'use strict';

const OFFSCREEN_PATH = 'offscreen.html';
let creatingOffscreen = null;
let syncEnabled = false;
let lastContentTabId = null;

chrome.runtime.onInstalled.addListener(function () {
    console.log('Watchtogether extension installed!');

    chrome.storage.sync.set({ ownId: null }, function () { });
    chrome.storage.sync.set({ remoteId: null }, function () { });
    chrome.storage.sync.set({ state: 'start' }, function () { });
    chrome.storage.sync.set({ connected: false }, function () { });
    chrome.storage.sync.set({ sync: false }, function () { });
});

chrome.storage.sync.get({ sync: false }, function (result) {
    syncEnabled = Boolean(result.sync);
    if (syncEnabled) {
        injectActiveTab();
    }
});

chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'sync' || !changes.sync) {
        return;
    }

    syncEnabled = Boolean(changes.sync.newValue);
    if (syncEnabled) {
        injectActiveTab();
    }
});

chrome.tabs.onActivated.addListener(function (activeInfo) {
    if (syncEnabled) {
        injectContentScript(activeInfo.tabId);
    }
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (syncEnabled && changeInfo.status === 'complete') {
        injectContentScript(tabId);
    }
});

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
    handleMessage(request, sender)
        .then(function () { sendResponse({ ok: true }); })
        .catch(function (error) {
            console.error(error);
            sendResponse({ ok: false, error: String(error) });
        });
    return true;
});

async function handleMessage(request, sender) {
    if (!request) {
        return;
    }

    if (request.target === 'offscreen') {
        return;
    }

    if (request.source === 'offscreen') {
        handleOffscreenEvent(request);
        return;
    }

    if (request.action === 'registerContent') {
        if (sender && sender.tab && sender.tab.id !== undefined) {
            lastContentTabId = sender.tab.id;
        }
        return;
    }

    if (request.action === 'newSession') {
        chrome.storage.sync.set({ role: 'leader' }, function () { });
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'newSession', initiator: true });
    } else if (request.action === 'joinSession') {
        if (!request.remoteId) {
            return;
        }
        chrome.storage.sync.set({ role: 'follower' }, function () { });
        chrome.storage.sync.set({ remoteId: request.remoteId }, function () { });
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'joinSession',
            remoteId: request.remoteId
        });
    } else if (request.action === 'disconnectPeers') {
        chrome.runtime.sendMessage({ target: 'offscreen', action: 'disconnectPeers' });
        resetSessionState();
    } else if (request.action === 'sendState') {
        if (!syncEnabled) {
            return;
        }
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({
            target: 'offscreen',
            action: 'sendState',
            content: request.content
        });
    }
}

function handleOffscreenEvent(message) {
    if (message.event === 'signal') {
        chrome.storage.sync.set({ ownId: message.ownId }, function () { });
    } else if (message.event === 'connect') {
        chrome.storage.sync.set({ connected: true }, function () { });
        chrome.storage.sync.set({ sync: true }, function () { });
    } else if (message.event === 'data') {
        deliverVideoState(message.videoState);
    } else if (message.event === 'close') {
        resetSessionState();
    } else if (message.event === 'error') {
        console.log(message.error);
    }
}

function resetSessionState() {
    chrome.storage.sync.set({ ownId: null }, function () { });
    chrome.storage.sync.set({ remoteId: null }, function () { });
    chrome.storage.sync.set({ state: 'start' }, function () { });
    chrome.storage.sync.set({ connected: false }, function () { });
    chrome.storage.sync.set({ sync: false }, function () { });
    chrome.storage.sync.set({ role: null }, function () { });
}

function injectActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (!tabs || tabs.length === 0) {
            return;
        }
        if (tabs[0].id !== undefined) {
            injectContentScript(tabs[0].id);
        }
    });
}

function injectContentScript(tabId) {
    chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ['content.js']
    }, function () {
        let e = chrome.runtime.lastError;
        if (e !== undefined) {
            console.log(e);
        }
    });
}

function deliverVideoState(videoState) {
    if (!syncEnabled) {
        return;
    }

    const payload = { action: 'applyState', content: videoState };

    if (lastContentTabId !== null) {
        chrome.tabs.sendMessage(lastContentTabId, payload, function () {
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
            reasons: ['WEB_RTC'],
            justification: 'Maintain a WebRTC peer connection for synchronized playback.'
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
