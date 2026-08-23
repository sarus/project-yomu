import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SpeechAssessmentProvider,
  WordAssessmentResult,
} from '../asr.types';

// Raw shape of Azure's response — only the fields we actually read.
// Kept local to this file since nothing outside the adapter should
// depend on Azure's specific response shape.
interface AzureSttResponse {
  DisplayText?: string;
  NBest?: Array<{
    Lexical?: string;
    AccuracyScore?: number;
    FluencyScore?: number;
    CompletenessScore?: number;
    PronScore?: number;
    Words?: Array<{
      Word: string;
      AccuracyScore?: number;
      Phonemes?: Array<{
        Phoneme: string;
        AccuracyScore?: number;
      }>;
    }>;
  }>;
}

const CORRECT_THRESHOLD = 80; // AccuracyScore floor to count a word as "correct"

@Injectable()
export class AzureSpeechProvider implements SpeechAssessmentProvider {
  private readonly logger = new Logger(AzureSpeechProvider.name);
  private readonly endpoint: string;
  private readonly apiKey: string;

  constructor(private readonly config: ConfigService) {
    const region = this.config.getOrThrow<string>('AZURE_SPEECH_REGION');
    this.apiKey = this.config.getOrThrow<string>('AZURE_SPEECH_KEY');
    this.endpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`;
  }

  async assessWord(audio: Buffer, referenceWord: string): Promise<WordAssessmentResult> {
    const pronunciationConfig = {
      ReferenceText: referenceWord,
      GradingSystem: 'HundredMark',
      Granularity: 'Phoneme',
      Dimension: 'Comprehensive',
    };
    const pronunciationHeader = Buffer.from(
      JSON.stringify(pronunciationConfig),
    ).toString('base64');

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.apiKey,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Pronunciation-Assessment': pronunciationHeader,
        Accept: 'application/json',
      },
      body: new Uint8Array(audio),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      this.logger.error(`Azure Speech error ${response.status}: ${errorBody}`);
      throw new Error(`Azure Speech API request failed (${response.status})`);
    }

    const data = (await response.json()) as AzureSttResponse;
    return this.normalize(data, referenceWord);
  }

  private normalize(
    data: AzureSttResponse,
    referenceWord: string,
  ): WordAssessmentResult {
    const nBest = data.NBest?.[0];
    // Azure's Display/DisplayText applies ITN (inverse text normalization) —
    // punctuation, and for things like numbers, converting words to digits
    // ("two" -> "2."). That's fine for a human-readable transcript but breaks
    // matching against the reference word, and it can also come back empty
    // entirely on some successful recognitions. Lexical is the raw, un-ITN'd
    // transcription and has been reliable in every case we've seen — use it
    // unconditionally instead.
    const recognizedText = (nBest?.Lexical ?? '').trim();

    const wordMatches =
      recognizedText.toLowerCase().replace(/[.,!?]/g, '') ===
      referenceWord.toLowerCase().trim();
    const accuracyScore = nBest?.AccuracyScore ?? 0;

    const phonemeBreakdown = nBest?.Words?.[0]?.Phonemes?.map((p) => ({
      phoneme: p.Phoneme,
      accuracyScore: p.AccuracyScore ?? 0,
    }));

    return {
      correct: wordMatches && accuracyScore >= CORRECT_THRESHOLD,
      accuracyScore,
      recognizedText,
      phonemeBreakdown,
      provider: 'azure',
      rawProviderResponse: data,
    };
  }
}
