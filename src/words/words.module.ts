import { Module } from '@nestjs/common';
import { WordsController } from './words.controller';

@Module({
  controllers: [WordsController],
})
export class WordsModule {}
