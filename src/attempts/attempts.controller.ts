import {
  Controller,
  Post,
  Get,
  Delete,
  Req,
  Res,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AttemptsService } from './attempts.service';

interface AuthedRequest extends FastifyRequest {
  user: { userId: number; email: string };
}

@Controller('attempts')
@UseGuards(JwtAuthGuard)
export class AttemptsController {
  constructor(private readonly attempts: AttemptsService) {}

  // Expects multipart/form-data: fields "word", "gradeLevel", "pipeline"
  // (which client-side audio pipeline produced this recording — e.g.
  // 'tier0-native' or 'tier1-gtcrn') and optional "comparisonGroupId"
  // (links the 2 submissions from a single "compare both pipelines"
  // recording), file field "audio" (wav, 16kHz PCM).
  @Post()
  async submit(@Req() req: AuthedRequest) {
    const parts = req.parts();
    let word: string | undefined;
    let gradeLevel: string | undefined;
    let pipeline: string | undefined;
    let comparisonGroupId: string | undefined;
    let audioBuffer: Buffer | undefined;

    for await (const part of parts) {
      if (part.type === 'file' && part.fieldname === 'audio') {
        audioBuffer = await part.toBuffer();
      } else if (part.type === 'field' && part.fieldname === 'word') {
        word = String(part.value);
      } else if (part.type === 'field' && part.fieldname === 'gradeLevel') {
        gradeLevel = String(part.value);
      } else if (part.type === 'field' && part.fieldname === 'pipeline') {
        pipeline = String(part.value);
      } else if (part.type === 'field' && part.fieldname === 'comparisonGroupId') {
        comparisonGroupId = String(part.value);
      }
    }

    if (!word || !audioBuffer || !pipeline) {
      throw new BadRequestException('"word", "pipeline" fields and "audio" file are required');
    }

    return this.attempts.submitAttempt(
      req.user.userId,
      word,
      gradeLevel,
      audioBuffer,
      pipeline,
      comparisonGroupId,
    );
  }

  @Delete()
  clearAll() {
    return this.attempts.clearAll();
  }

  @Post(':id/flag')
  flagIncorrect(@Param('id', ParseIntPipe) id: number, @Req() req: AuthedRequest) {
    return this.attempts.flagIncorrect(req.user.userId, id);
  }

  @Get('history')
  getHistory(@Req() req: AuthedRequest) {
    return this.attempts.getHistory(req.user.userId);
  }

  @Get('summary')
  getSummary(@Req() req: AuthedRequest) {
    return this.attempts.getSummary(req.user.userId);
  }

  @Get('audit')
  getAudit(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '25',
    @Query('flaggedOnly') flaggedOnly?: string,
  ) {
    return this.attempts.getAudit(
      Math.max(1, parseInt(page, 10) || 1),
      Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25)),
      flaggedOnly === 'true',
    );
  }

  @Get(':id/audio')
  async getAudio(@Param('id', ParseIntPipe) id: number, @Res() res: FastifyReply) {
    const audio = await this.attempts.getAudio(id);
    res.header('Content-Type', 'audio/wav').send(audio);
  }
}
