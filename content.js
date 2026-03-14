'use strict';

if (window.contentScriptVideo !== true) {
    window.contentScriptVideo = true;

    const MAX_DRIFT_PLAYING = 0.75;
    const MAX_DRIFT_PAUSED = 0.2;
    const SEND_INTERVAL_MS = 750;

    let role = null;
    let syncEnabled = false;
    let currentVideo = null;
    let lastSentAt = 0;
    let suppressSendUntil = 0;
    let pendingRemoteState = null;

    registerContent();

    chrome.storage.sync.get({ role: null, sync: false }, function (result) {
        role = result.role;
        syncEnabled = Boolean(result.sync);
    });

    chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'sync') {
            return;
        }

        if (changes.role) {
            role = changes.role.newValue;
        }
        if (changes.sync) {
            syncEnabled = Boolean(changes.sync.newValue);
        }
    });

    chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.action === 'applyState') {
            applyRemoteState(message.content);
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
            chrome.runtime.sendMessage({ action: 'registerContent' });
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
        currentVideo.addEventListener('canplay', applyPendingState);
        currentVideo.addEventListener('loadedmetadata', applyPendingState);

        maybeSendState(true);
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
        video.removeEventListener('canplay', applyPendingState);
        video.removeEventListener('loadedmetadata', applyPendingState);
    }

    function onImmediateEvent() {
        maybeSendState(true);
    }

    function onTimeUpdate() {
        maybeSendState(false);
    }

    function maybeSendState(force) {
        if (!currentVideo || !syncEnabled || role !== 'leader') {
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
        sendState(currentVideo);
    }

    function sendState(video) {
        const videoState = {
            url: window.location.href,
            isPaused: video.paused,
            currentTime: video.currentTime,
            playbackRate: video.playbackRate
        };

        try {
            chrome.runtime.sendMessage({ action: 'sendState', content: videoState });
        } catch (error) {
            console.log(error);
        }
    }

    function applyRemoteState(videoState) {
        if (!videoState || !syncEnabled || role !== 'follower') {
            return;
        }

        if (!currentVideo || currentVideo.readyState <= 2) {
            pendingRemoteState = videoState;
            return;
        }

        const url = window.location.href;
        if (!(url.startsWith(videoState.url) || videoState.url.startsWith(url))) {
            return;
        }

        suppressSendUntil = Date.now() + 500;

        if (videoState.isPaused) {
            if (!currentVideo.paused) {
                currentVideo.pause();
            }
            if (Math.abs(currentVideo.currentTime - videoState.currentTime) > MAX_DRIFT_PAUSED) {
                currentVideo.currentTime = videoState.currentTime;
            }
        } else {
            if (currentVideo.paused) {
                currentVideo.play().catch(function () { });
            }
            if (typeof videoState.playbackRate === 'number' &&
                Math.abs(currentVideo.playbackRate - videoState.playbackRate) > 0.01) {
                currentVideo.playbackRate = videoState.playbackRate;
            }
            if (Math.abs(currentVideo.currentTime - videoState.currentTime) > MAX_DRIFT_PLAYING) {
                currentVideo.currentTime = videoState.currentTime;
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
