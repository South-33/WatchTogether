'use strict';

const elements = {
    statusPill: document.getElementById('statusPill'),
    roleTag: document.getElementById('roleTag'),
    sessionCode: document.getElementById('sessionCode'),
    copyCode: document.getElementById('copyCode'),
    createBtn: document.getElementById('createBtn'),
    joinBtn: document.getElementById('joinBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    joinCode: document.getElementById('joinCode'),
    activateTab: document.getElementById('activateTab'),
    activeUrl: document.getElementById('activeUrl'),
    autoSyncToggle: document.getElementById('autoSyncToggle'),
    leaderTime: document.getElementById('leaderTime'),
    localTime: document.getElementById('localTime'),
    driftValue: document.getElementById('driftValue'),
    resyncBtn: document.getElementById('resyncBtn'),
    requestResyncBtn: document.getElementById('requestResyncBtn'),
    participantsList: document.getElementById('participantsList'),
    participantCount: document.getElementById('participantCount'),
    autoPausedLabel: document.getElementById('autoPausedLabel'),
    resyncRequest: document.getElementById('resyncRequest'),
    convexUrl: document.getElementById('convexUrl'),
    saveConvexUrl: document.getElementById('saveConvexUrl'),
    errorText: document.getElementById('errorText')
};

let currentState = null;

init();

function init() {
    elements.createBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'ui:createSession' });
    });

    elements.joinBtn.addEventListener('click', function () {
        const code = elements.joinCode.value.trim().toUpperCase();
        if (!code) {
            return;
        }
        chrome.runtime.sendMessage({ action: 'ui:joinSession', code });
    });

    elements.joinCode.addEventListener('input', function () {
        elements.joinCode.value = elements.joinCode.value.toUpperCase();
    });

    elements.leaveBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'ui:leaveSession' });
    });

    elements.activateTab.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'ui:activateTab' });
    });

    elements.copyCode.addEventListener('click', function () {
        if (!currentState || !currentState.sessionCode) {
            return;
        }
        copyToClipboard(currentState.sessionCode);
        elements.copyCode.textContent = 'Copied';
        setTimeout(function () {
            elements.copyCode.textContent = 'Copy';
        }, 1200);
    });

    elements.autoSyncToggle.addEventListener('change', function () {
        chrome.runtime.sendMessage({
            action: 'ui:toggleAutoSync',
            autoSync: elements.autoSyncToggle.checked
        });
    });

    elements.resyncBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'ui:resyncNow' });
    });

    elements.requestResyncBtn.addEventListener('click', function () {
        chrome.runtime.sendMessage({ action: 'ui:requestResync' });
    });

    elements.saveConvexUrl.addEventListener('click', function () {
        const url = elements.convexUrl.value.trim();
        chrome.runtime.sendMessage({ action: 'ui:setConvexUrl', convexUrl: url });
    });

    chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') {
            return;
        }
        const nextState = { ...currentState };
        for (const key in changes) {
            nextState[key] = changes[key].newValue;
        }
        applyState(nextState);
    });

    chrome.runtime.sendMessage({ action: 'ui:getStatus' }, function (response) {
        if (response && response.ok) {
            applyState(response.data);
        }
    });
}

function applyState(state) {
    if (!state) {
        return;
    }
    currentState = state;

    const connected = Boolean(state.connected);
    elements.statusPill.textContent = connected ? 'Live' : 'Idle';
    elements.roleTag.textContent = state.role ? state.role.toUpperCase() : 'NO ROLE';
    elements.sessionCode.textContent = state.sessionCode || '------';
    elements.joinCode.disabled = connected;
    elements.createBtn.disabled = connected;
    elements.joinBtn.disabled = connected;
    elements.leaveBtn.disabled = !connected;
    elements.autoSyncToggle.checked = Boolean(state.autoSync);
    elements.autoSyncToggle.disabled = Boolean(state.role) && state.role !== 'leader';

    elements.activeUrl.textContent = state.activeTabUrl
        ? truncateUrl(state.activeTabUrl)
        : 'No tab selected';

    elements.autoPausedLabel.textContent = state.autoPaused ? 'Auto-paused for buffering' : '';

    const leaderSeconds = deriveLeaderTime(state.lastLeaderState);
    const localSeconds = state.localState ? state.localState.position : null;
    elements.leaderTime.textContent = formatTime(leaderSeconds);
    elements.localTime.textContent = formatTime(localSeconds);

    if (leaderSeconds !== null && localSeconds !== null) {
        const drift = localSeconds - leaderSeconds;
        elements.driftValue.textContent = formatDrift(drift);
    } else {
        elements.driftValue.textContent = '--';
    }

    elements.resyncBtn.disabled = state.role !== 'leader';
    elements.requestResyncBtn.disabled = state.role !== 'follower';

    if (state.resyncRequestedAt) {
        elements.resyncRequest.textContent = `Requested ${timeAgo(state.resyncRequestedAt)}`;
    } else {
        elements.resyncRequest.textContent = 'None';
    }

    if (state.convexUrl !== undefined) {
        elements.convexUrl.value = state.convexUrl || '';
    }

    renderParticipants(state.participants || [], state.clientId);

    elements.errorText.textContent = state.error || '';
}

function renderParticipants(participants, clientId) {
    elements.participantsList.innerHTML = '';
    elements.participantCount.textContent = `${participants.length} online`;

    if (!participants.length) {
        const empty = document.createElement('div');
        empty.className = 'participant';
        empty.textContent = 'No participants yet';
        elements.participantsList.appendChild(empty);
        return;
    }

    participants.forEach(function (participant) {
        const row = document.createElement('div');
        row.className = 'participant';

        const name = document.createElement('span');
        const shortId = participant.clientId
            ? participant.clientId.slice(0, 6)
            : 'anon';
        name.textContent = participant.clientId === clientId
            ? `You - ${participant.role}`
            : `${shortId} - ${participant.role}`;

        const status = document.createElement('span');
        status.className = 'participant__status';
        const dot = document.createElement('span');
        dot.className = participant.buffering ? 'dot dot--buffer' : 'dot';
        const label = document.createElement('span');
        label.textContent = participant.buffering ? 'buffering' : 'ready';
        status.appendChild(dot);
        status.appendChild(label);

        row.appendChild(name);
        row.appendChild(status);
        elements.participantsList.appendChild(row);
    });
}

function deriveLeaderTime(leaderState) {
    if (!leaderState) {
        return null;
    }
    if (leaderState.state === 'playing' && typeof leaderState.serverTs === 'number') {
        return leaderState.position + (Date.now() - leaderState.serverTs) / 1000;
    }
    return leaderState.position;
}

function formatTime(seconds) {
    if (typeof seconds !== 'number' || Number.isNaN(seconds)) {
        return '--:--';
    }
    const total = Math.max(0, Math.floor(seconds));
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0) {
        return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function formatDrift(value) {
    const sign = value >= 0 ? '+' : '-';
    return `${sign}${Math.abs(value).toFixed(2)}s`;
}

function truncateUrl(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.hostname}${parsed.pathname}`;
    } catch (error) {
        return url;
    }
}

function timeAgo(timestamp) {
    const delta = Date.now() - timestamp;
    if (delta < 10000) {
        return 'just now';
    }
    const seconds = Math.floor(delta / 1000);
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const mins = Math.floor(seconds / 60);
    if (mins < 60) {
        return `${mins}m ago`;
    }
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () { });
        return;
    }
    const temp = document.createElement('textarea');
    temp.value = text;
    document.body.appendChild(temp);
    temp.select();
    document.execCommand('copy');
    document.body.removeChild(temp);
}




