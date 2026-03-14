'use strict';

if (window.__watchTogetherContent !== true) {
    window.__watchTogetherContent = true;

    const DRIFT_PLAYING = 0.7;
    const DRIFT_PAUSED = 0.25;
    const SEND_INTERVAL_MS = 1000;
    const BUFFER_REPORT_INTERVAL_MS = 1000;
    const LOCAL_REPORT_INTERVAL_MS = 500;
    const HEARTBEAT_INTERVAL_MS = 5000;

    let role = null;
    let connected = false;
    let currentVideo = null;
    let lastSentAt = 0;
    let lastBufferReportAt = 0;
    let lastLocalReportAt = 0;
    let lastHeartbeatAt = 0;
    let suppressSendUntil = 0;
    let pendingRemoteState = null;

    registerContent();

    chrome.storage.local.get({ role: null, connected: false }, function (result) {
        role = result.role;
        connected = Boolean(result.connected);
    });

    chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') {
            return;
        }
        if (changes.role) {
            role = changes.role.newValue;
        }
        if (changes.connected) {
            connected = Boolean(changes.connected.newValue);
        }
    });

    chrome.runtime.onMessage.addListener(function (message) {
        if (!message) {
            return;
        }
        if (message.action === 'applyState') {
            applyRemoteState(message.content);
        } else if (message.action === 'autoPause') {
            if (currentVideo && !currentVideo.paused) {
                currentVideo.pause();
            }
        } else if (message.action === 'autoResume') {
            if (currentVideo && currentVideo.paused) {
                currentVideo.play().catch(function () { });
            }
        } else if (message.action === 'forceSync') {
            maybeSendState(true);
        }
    });

    const initialVideo = document.querySelector('video');
    if (initialVideo) {
        attachVideo(initialVideo);
    }

    const observer = new MutationObserver(function (mutations) {
        for (const { addedNodes } of mutations) {
            addedNodes.forEach(function (node) {
                if (!node || node.nodeType !== 1) {
                    return;
                }
                if (node.nodeName === 'VIDEO') {
                    attachVideo(node);
                    return;
                }
                if (node.querySelector) {
                    const nested = node.querySelector('video');
                    if (nested) {
                        attachVideo(nested);
                    }
                }
            });
        }
    });

    const observeTarget = document.body || document.documentElement;
    if (observeTarget) {
        observer.observe(observeTarget, { attributes: true, childList: true, subtree: true });
    }

    function registerContent() {
        try {
            chrome.runtime.sendMessage({ action: 'content:register' });
        } catch (error) {
            console.log(error);
        }
    }

    function attachVideo(video) {
        if (currentVideo === video || !video) {
            return;
        }

        if (currentVideo) {
            detachVideo(currentVideo);
        }

        currentVideo = video;
        currentVideo.addEventListener('pause', onImmediateEvent);
        currentVideo.addEventListener('play', onImmediateEvent);
        currentVideo.addEventListener('seeked', onImmediateEvent);
        currentVideo.addEventListener('ratechange', onImmediateEvent);
        currentVideo.addEventListener('timeupdate', onTimeUpdate);
        currentVideo.addEventListener('waiting', onBuffering);
        currentVideo.addEventListener('stalled', onBuffering);
        currentVideo.addEventListener('playing', onPlaying);
        currentVideo.addEventListener('canplay', onPlaying);
        currentVideo.addEventListener('loadedmetadata', applyPendingState);

        maybeSendState(true);
        reportLocalState();
        if (pendingRemoteState) {
            applyRemoteState(pendingRemoteState);
        }
    }

    function detachVideo(video) {
        video.removeEventListener('pause', onImmediateEvent);
        video.removeEventListener('play', onImmediateEvent);
        video.removeEventListener('seeked', onImmediateEvent);
        video.removeEventListener('ratechange', onImmediateEvent);
        video.removeEventListener('timeupdate', onTimeUpdate);
        video.removeEventListener('waiting', onBuffering);
        video.removeEventListener('stalled', onBuffering);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('canplay', onPlaying);
        video.removeEventListener('loadedmetadata', applyPendingState);
    }

    function onImmediateEvent() {
        maybeSendState(true);
        reportLocalState();
        maybeHeartbeat();
    }

    function onTimeUpdate() {
        maybeSendState(false);
        reportLocalState();
        maybeHeartbeat();
    }

    function onBuffering() {
        reportBuffering(true);
    }

    function onPlaying() {
        reportBuffering(false);
        maybeHeartbeat();
    }

    function maybeSendState(force) {
        if (!currentVideo || !connected || role !== 'leader') {
            return;
        }
        if (Date.now() < suppressSendUntil) {
            return;
        }
        if (!force && Date.now() - lastSentAt < SEND_INTERVAL_MS) {
            return;
        }
        if (currentVideo.readyState <= 2) {
            return;
        }

        lastSentAt = Date.now();
        sendLeaderState(currentVideo);
    }

    function sendLeaderState(video) {
        const payload = {
            action: 'content:leaderState',
            url: window.location.href,
            state: video.paused ? 'paused' : 'playing',
            position: video.currentTime,
            playbackRate: video.playbackRate
        };

        try {
            chrome.runtime.sendMessage(payload);
        } catch (error) {
            console.log(error);
        }
    }

    function reportBuffering(isBuffering) {
        if (!currentVideo || !connected || role !== 'follower') {
            return;
        }
        const now = Date.now();
        if (now - lastBufferReportAt < BUFFER_REPORT_INTERVAL_MS) {
            return;
        }
        lastBufferReportAt = now;

        chrome.runtime.sendMessage({
            action: 'content:participantStatus',
            buffering: isBuffering,
            lastPosition: currentVideo.currentTime
        });
    }

    function maybeHeartbeat() {
        if (!currentVideo || !connected || role !== 'follower') {
            return;
        }
        const now = Date.now();
        if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) {
            return;
        }
        lastHeartbeatAt = now;
        chrome.runtime.sendMessage({
            action: 'content:participantStatus',
            buffering: false,
            lastPosition: currentVideo.currentTime
        });
    }

    function reportLocalState() {
        if (!currentVideo || !connected) {
            return;
        }
        const now = Date.now();
        if (now - lastLocalReportAt < LOCAL_REPORT_INTERVAL_MS) {
            return;
        }
        lastLocalReportAt = now;
        chrome.runtime.sendMessage({
            action: 'content:localState',
            localState: {
                position: currentVideo.currentTime,
                isPaused: currentVideo.paused,
                playbackRate: currentVideo.playbackRate,
                at: now
            }
        });
    }

    function applyRemoteState(session) {
        if (!session || !connected || role !== 'follower') {
            return;
        }

        if (!currentVideo || currentVideo.readyState <= 2) {
            pendingRemoteState = session;
            return;
        }

        if (session.url) {
            const url = window.location.href;
            if (!(url.startsWith(session.url) || session.url.startsWith(url))) {
                return;
            }
        }

        const expected =
            session.state === 'playing'
                ? session.position + (Date.now() - session.serverTs) / 1000
                : session.position;

        suppressSendUntil = Date.now() + 500;

        if (session.state === 'paused') {
            if (!currentVideo.paused) {
                currentVideo.pause();
            }
            if (Math.abs(currentVideo.currentTime - session.position) > DRIFT_PAUSED) {
                currentVideo.currentTime = session.position;
            }
        } else {
            if (currentVideo.paused) {
                currentVideo.play().catch(function () { });
            }
            if (typeof session.playbackRate === 'number' &&
                Math.abs(currentVideo.playbackRate - session.playbackRate) > 0.01) {
                currentVideo.playbackRate = session.playbackRate;
            }
            if (Math.abs(currentVideo.currentTime - expected) > DRIFT_PLAYING) {
                currentVideo.currentTime = expected;
            }
        }

        pendingRemoteState = null;
    }

    function applyPendingState() {
        if (pendingRemoteState) {
            applyRemoteState(pendingRemoteState);
        }
    }
}
