# AGENTS

## Notes
- MV3 Convex realtime -> keep Convex client in offscreen doc and route via service worker (offscreen only supports `chrome.runtime`) -> moving tab logic into offscreen will break.
- Video sync -> avoid `chrome.storage.sync` for streaming state; use runtime messaging and leader-only updates -> sync jitter and quota throttling.
- Build -> `convex/_generated/api.js` must exist before `vite build` (run `pnpm convex dev` once) -> bundler import will fail otherwise.
- Convex 1.33+ -> use `./_generated/server` for `mutation/query` and `internal.*` references in `cronJobs` -> direct imports from function modules break cron scheduling.
