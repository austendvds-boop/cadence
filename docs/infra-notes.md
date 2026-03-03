# Infrastructure Notes (Phase 3)

Date: 2026-03-02

## Config audit
- `render.yaml`: not present in repository.
- `railway.toml`: present, but no deployment region is specified.
- No Render service region is declared in repo-managed config.

## Recommendation
- If Cadence remains on Render, set the service region to **Oregon** for lower latency to Deepgram + Groq US endpoints.
- Long-term best latency option for real-time voice is **Fly.io `sjc` (San Jose)** for sub-500ms turn latency targets.

## Notes
- This is documentation-only; no infrastructure migration was performed in this change set.
