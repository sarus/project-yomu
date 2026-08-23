import { Module } from '@nestjs/common';
import { AzureSpeechProvider } from './providers/azure-speech.provider';
import { AzureTtsProvider } from './providers/azure-tts.provider';
import { TtsController } from './tts.controller';

// The DI token the rest of the app depends on — not the concrete class.
// Swapping providers later (Deepgram, Speechace) means changing the
// `useClass` line below, nothing else in the codebase.
export const ASR_PROVIDER = Symbol('ASR_PROVIDER');

@Module({
  controllers: [TtsController],
  providers: [
    {
      provide: ASR_PROVIDER,
      useClass: AzureSpeechProvider,
    },
    AzureTtsProvider,
  ],
  exports: [ASR_PROVIDER],
})
export class AsrModule {}
