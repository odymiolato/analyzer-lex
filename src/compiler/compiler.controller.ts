import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { CompilerService } from './compiler.service';

interface CodeDto {
  code: string;
}

interface TranslateDto {
  code: string;
  target: 'javascript' | 'cpp';
}

@Controller('compiler')
export class CompilerController {
  constructor(private readonly compilerService: CompilerService) {}

  /** POST /compiler/tokenize  →  análisis léxico */
  @Post('tokenize')
  tokenize(@Body() body: CodeDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    const tokens = this.compilerService.tokenize(body.code);
    return { tokens };
  }

  /** POST /compiler/parse  →  análisis sintáctico */
  @Post('parse')
  parse(@Body() body: CodeDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    const { cst, errors } = this.compilerService.parse(body.code);
    return { cst, errors };
  }

  /** POST /compiler/analyze  →  análisis semántico */
  @Post('analyze')
  analyze(@Body() body: CodeDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    const { cst, syntaxErrors, semantic } = this.compilerService.analyze(body.code);
    return { cst, syntaxErrors, semantic };
  }

  /** POST /compiler/translate  →  traducción de C a JS o C++ */
  @Post('translate')
  translate(@Body() body: TranslateDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    if (!body?.target) {
      throw new BadRequestException('El campo "target" es requerido (javascript | cpp)');
    }
    return this.compilerService.translate(body.code, body.target);
  }
}
