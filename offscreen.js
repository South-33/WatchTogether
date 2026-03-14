'use strict';

let peer = null;

chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.target !== 'offscreen') {
        return;
    }

    if (message.action === 'newSession') {
        createPeer(Boolean(message.initiator));
    } else if (message.action === 'joinSession') {
        if (!peer) {
            createPeer(false);
        }
        joinSession(message.remoteId);
    } else if (message.action === 'disconnectPeers') {
        disconnectPeers();
    } else if (message.action === 'sendState') {
        sendState(message.content);
    }

});

function createPeer(initiator) {
    peer = new SimplePeer({
        initiator: initiator ? true : false,
        trickle: false
    });

    peer.on('error', function (err) {
        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'error',
            error: err ? String(err) : 'Unknown peer error'
        });
    });

    peer.on('signal', function (data) {
        let id = btoa(JSON.stringify(data));
        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'signal',
            ownId: id
        });
    });

    peer.on('connect', function () {
        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'connect'
        });
    });

    peer.on('data', function (data) {
        let videoState = null;
        try {
            videoState = JSON.parse(atob(data));
        } catch (error) {
            chrome.runtime.sendMessage({
                source: 'offscreen',
                event: 'error',
                error: String(error)
            });
            return;
        }

        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'data',
            videoState: videoState
        });
    });

    peer.on('close', function () {
        peer = null;
        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'close'
        });
    });
}

function joinSession(remoteId) {
    if (!remoteId) {
        return;
    }
    try {
        peer.signal(JSON.parse(atob(remoteId)));
    } catch (error) {
        chrome.runtime.sendMessage({
            source: 'offscreen',
            event: 'error',
            error: String(error)
        });
    }
}

function disconnectPeers() {
    if (peer) {
        peer.destroy();
    }
}

function sendState(content) {
    if (peer) {
        peer.send(btoa(JSON.stringify(content)));
    }
}
