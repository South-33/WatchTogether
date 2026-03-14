# AGENTS

## Notes
- MV3 WebRTC -> keep SimplePeer in offscreen doc and route messages via service worker (offscreen only supports `chrome.runtime`) -> moving tabs/storage into offscreen will break.
- Video sync -> avoid `chrome.storage.sync` for streaming state; use runtime messaging and leader-only updates -> sync jitter and quota throttling.
