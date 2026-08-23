/**
 * Normalized result shape — every provider adapter maps its raw response into this.
 * Downstream code (attempts service, DB writes) only ever depends on this shape,
 * never on a specific provider's response format.
 */
export interface WordAssessmentResult {
  correct: boolean;
  accuracyScore: number; // 0-100 — pronunciation accuracy, not ASR transcription confidence
  recognizedText: string;
  phonemeBreakdown?: PhonemeScore[];
  provider: string;
  rawProviderResponse: unknown; // kept for auditing / future comparison, per our provider-abstraction plan
}

export interface PhonemeScore {
  phoneme: string;
  accuracyScore: number; // 0-100
}

/**
 * The interface every ASR provider adapter implements. Only assessWord for this
 * test build — assessPassage (Tier 2) is a deliberate later addition once a
 * passage-fluency provider (e.g. Speechace) is wired in.
 */
export interface SpeechAssessmentProvider {
  assessWord(audio: Buffer, referenceWord: string): Promise<WordAssessmentResult>;
}
