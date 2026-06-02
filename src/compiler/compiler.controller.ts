import {
  Body,
  Controller,
  Post
} from '@nestjs/common';

import { CompilerService } from './compiler.service';
import { AnalyzeCodeDto } from './dto/analyze-code.dto';

@Controller('compiler')
export class CompilerController {

  constructor(
    private readonly compilerService: CompilerService
  ) {}

  @Post('tokenize')
  tokenize(
    @Body() dto: AnalyzeCodeDto
  ) {
    return this.compilerService.tokenize(dto.source);
  }
}