import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AzureTtsProvider,
  DEFAULT_TTS_VOICE,
  TTS_VOICES,
  TtsVoiceKey,
} from './providers/azure-tts.provider';

@Controller('tts')
@UseGuards(JwtAuthGuard)
export class TtsController {
  constructor(private readonly tts: AzureTtsProvider) {}

  @Get()
  async synthesize(
    @Query('word') word: string,
    @Query('voice') voice: string | undefined,
    @Res() res: FastifyReply,
  ) {
    if (!word) {
      throw new BadRequestException('Query param "word" is required');
    }
    if (voice && !(voice in TTS_VOICES)) {
      throw new BadRequestException(
        `Unknown voice "${voice}". Valid: ${Object.keys(TTS_VOICES).join(', ')}`,
      );
    }
    const audio = await this.tts.synthesize(word, (voice as TtsVoiceKey) ?? DEFAULT_TTS_VOICE);
    res.header('Content-Type', 'audio/mpeg').send(audio);
  }
}
