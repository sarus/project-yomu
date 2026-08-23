# yomu-test

Minimal test implementation to validate the sight-word ASR pipeline end to
end before building the full product. Deliberately excludes: parent
dashboard, live/real-time updates, billing. Included: Google auth, sight
word lists by grade, basic attempt tracking, and a provider-abstracted
wrapper around Azure's pronunciation assessment API.

## Why it's structured this way

The ASR call is hidden behind `SpeechAssessmentProvider` (`src/asr/asr.types.ts`),
with `AzureSpeechProvider` as the only implementation right now. Everything
else in the app — the attempts service, the DB schema — depends only on the
normalized `WordAssessmentResult` shape, never on Azure's response format
directly. Adding Deepgram, Google STT, or Speechace later means writing one
new class and changing one line in `src/asr/asr.module.ts`; nothing else
should need to change. The raw provider response is stored alongside the
normalized result in `word_attempts.raw_provider_response` specifically so
you can compare providers side by side later, per our earlier discussion.

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Environment** — copy `.env.example` to `.env` and fill in:
   - `DATABASE_URL` — your Neon connection string (use the pooled endpoint)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from Google Cloud Console
     (OAuth consent screen + credentials; add
     `http://localhost:3000/auth/google/callback` as an authorized redirect
     URI for local dev)
   - `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` — from your Azure Speech
     resource
   - `JWT_SECRET`, `SESSION_SECRET` — any random strings for local dev

3. **Database** — push the schema to Neon:
   ```
   npm run db:generate
   npm run db:migrate
   ```

4. **Run locally**
   ```
   npm run start:dev
   ```
   A minimal test harness is served at `http://localhost:3000/` by this same
   app — log in with Google and exercise the full flow (words, recording,
   submitting attempts, history/summary) directly in the browser, no
   separate frontend needed.

## API surface

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /auth/google` | — | Starts Google OAuth flow |
| `GET /auth/google/callback` | — | OAuth callback, issues a JWT |
| `GET /words?grade=1st` | JWT | Sight words for a grade (`pre-k`, `kindergarten`, `1st`, `2nd`, `3rd`); omit `grade` for all |
| `POST /attempts` | JWT | Multipart: `word` field, `gradeLevel` field, `audio` file (WAV, 16kHz PCM) — runs it through Azure, stores + returns the result |
| `GET /attempts/history` | JWT | Recent attempts |
| `GET /attempts/summary` | JWT | Accuracy + a first-pass "mastered words" list (2+ correct reads) |

All protected routes expect `Authorization: Bearer <token>` using the JWT
returned from the OAuth callback redirect.

## Audio format note

Azure's pronunciation assessment endpoint used here expects 16kHz mono PCM
WAV. If your client records in a browser-native format (e.g. WebM/Opus via
MediaRecorder), you'll need to transcode to WAV client-side or in a small
server-side step before calling `/attempts` — not handled in this test
build, since the point right now is validating the assessment quality
itself, not production audio pipeline polish.

## Deploying to Fly.io

```
fly launch --no-deploy   # creates the app, skip if fly.toml already matches your app name
fly secrets set \
  DATABASE_URL="..." \
  JWT_SECRET="..." \
  GOOGLE_CLIENT_ID="..." \
  GOOGLE_CLIENT_SECRET="..." \
  GOOGLE_CALLBACK_URL="https://yomu-test.fly.dev/auth/google/callback" \
  AZURE_SPEECH_KEY="..." \
  AZURE_SPEECH_REGION="eastus" \
  CLIENT_URL="https://your-test-client.example.com"
fly deploy
```

Remember to also add the production callback URL as an authorized redirect
URI in the Google Cloud Console credentials.

## What's deliberately not here

- No parent/child account split — every Google-authenticated user is just
  "a user" for this test.
- No real-time layer (Ably/Pusher) — history and summary are pull-based
  (`GET` endpoints), not pushed live.
- No billing/Stripe.
- No streaming/Tier 2 passage reading — single-word clips only, matching
  the current ASR validation goal.

These are the pieces to add once the ASR provider choice and quality bar
are validated against real audio.
