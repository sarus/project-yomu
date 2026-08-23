import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SIGHT_WORDS } from './sight-words.data';

@Controller('words')
@UseGuards(JwtAuthGuard)
export class WordsController {
  @Get()
  getWords(@Query('grade') grade?: string) {
    if (!grade) {
      // No grade specified — return everything, grouped, so the client can decide.
      return SIGHT_WORDS;
    }
    const list = SIGHT_WORDS[grade];
    if (!list) {
      throw new BadRequestException(
        `Unknown grade "${grade}". Valid: ${Object.keys(SIGHT_WORDS).join(', ')}`,
      );
    }
    return { grade, words: list };
  }
}
