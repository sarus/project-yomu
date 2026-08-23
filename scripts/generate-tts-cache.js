// One-off/incremental script: pre-generates Azure TTS audio for every word in
// every sight-word list, for every voice, and saves it as a static file under
// public/tts-cache/<voice>/<word>.mp3 — served directly by @fastify/static,
// no live Azure call needed at request time. Idempotent: skips files that
// already exist, so re-running after adding a new word list only generates
// the new words.
//
// Run with: npm run tts:cache   (requires `npm run build` first — it reuses
// the compiled AzureTtsProvider so the cache always matches the real
// synthesis logic, no duplicated SSML/escaping code to drift out of sync.)

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { AzureTtsProvider, TTS_VOICES } = require('../dist/asr/providers/azure-tts.provider');
const { SIGHT_WORDS } = require('../dist/words/sight-words.data');

const DELAY_MS = 150; // be gentle on the API — a few thousand calls run serially

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = {
  getOrThrow(key) {
    const value = process.env[key];
    if (!value) throw new Error(`Missing env var ${key}`);
    return value;
  },
};

async function main() {
  const tts = new AzureTtsProvider(config);
  const allWords = [...new Set(Object.values(SIGHT_WORDS).flat())];
  const voiceKeys = Object.keys(TTS_VOICES);

  console.log(
    `Generating TTS cache for ${allWords.length} words x ${voiceKeys.length} voices ` +
      `(${allWords.length * voiceKeys.length} files max)`,
  );

  let generated = 0;
  let skipped = 0;

  for (const voice of voiceKeys) {
    const voiceDir = path.join(__dirname, '..', 'public', 'tts-cache', voice);
    fs.mkdirSync(voiceDir, { recursive: true });

    for (const word of allWords) {
      const filePath = path.join(voiceDir, `${word}.mp3`);
      if (fs.existsSync(filePath)) {
        skipped++;
        continue;
      }

      const audio = await tts.synthesize(word, voice);
      fs.writeFileSync(filePath, audio);
      generated++;
      console.log(`  [${voice}] ${word}`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`Done. Generated ${generated}, skipped ${skipped} (already cached).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
