import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Curated subset of Azure's en-US neural voices — also drives the picker in public/app.js.
// Kept as an allow-list (not free-text) so the query param can't break out of the SSML attribute.
export const TTS_VOICES = {
  jenny: 'en-US-JennyNeural',
  aria: 'en-US-AriaNeural',
  guy: 'en-US-GuyNeural',
  davis: 'en-US-DavisNeural',
  ana: 'en-US-AnaNeural', // Microsoft's voice tuned for children's content
} as const;

export type TtsVoiceKey = keyof typeof TTS_VOICES;
export const DEFAULT_TTS_VOICE: TtsVoiceKey = 'jenny';

@Injectable()
export class AzureTtsProvider {
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    const region = config.getOrThrow<string>('AZURE_SPEECH_REGION');
    this.apiKey = config.getOrThrow<string>('AZURE_SPEECH_KEY');
    this.endpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  }

  async synthesize(text: string, voice: TtsVoiceKey): Promise<Buffer> {
    const voiceName = TTS_VOICES[voice];
    const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='${voiceName}'>${escapeXml(text)}</voice></speak>`;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-32kbitrate-mono-mp3',
        'User-Agent': 'yomu-test',
      },
      body: ssml,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Azure TTS request failed (${response.status}): ${errorBody}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
