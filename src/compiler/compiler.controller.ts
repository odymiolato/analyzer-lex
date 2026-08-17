import { Controller, Post, Get, Body, Param, Res, BadRequestException, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { CompilerService } from './compiler.service';
import { BuildService } from './build.service';

interface CodeDto {
  code: string;
}

interface TranslateDto {
  code: string;
  target: 'javascript' | 'cpp';
}

@Controller('compiler')
export class CompilerController {
  constructor(
    private readonly compilerService: CompilerService,
    private readonly buildService: BuildService,
  ) {}

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

  /** POST /compiler/codegen  →  generación de código destino (TAC) */
  @Post('codegen')
  codegen(@Body() body: CodeDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    return this.compilerService.generateTarget(body.code);
  }

  /** POST /compiler/optimize  →  optimización del código destino */
  @Post('optimize')
  optimize(@Body() body: CodeDto) {
    if (!body?.code?.trim()) {
      throw new BadRequestException('El campo "code" es requerido');
    }
    return this.compilerService.optimize(body.code);
  }

  /**
   * POST /compiler/build  →  pipeline completo (léxico → … → ejecutable).
   * Responde en NDJSON (un evento JSON por línea) para que el cliente pueda
   * mostrar el progreso fase por fase mientras el servidor compila.
   */
  @Post('build')
  async build(@Body() body: CodeDto, @Res() res: Response) {
    if (!body?.code?.trim()) {
      res.status(400).json({ message: 'El campo "code" es requerido' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();

    await this.buildService.build(body.code, (event) => {
      res.write(JSON.stringify(event) + '\n');
    });

    res.end();
  }

  /** GET /compiler/build/:id/download  →  descarga el ejecutable generado */
  @Get('build/:id/download')
  download(@Param('id') id: string, @Res() res: Response) {
    const record = this.buildService.getBuild(id);
    if (!record) {
      throw new NotFoundException('El ejecutable no existe o ya expiró');
    }
    res.download(record.filePath, record.fileName);
  }
}
