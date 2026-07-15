import { Injectable, BadRequestException } from '@nestjs/common';
import { lexer } from './lexer';
import { CParser, CSTNode, SyntaxError, MooToken } from './c.parser';
import { SemanticAnalyzer, SemanticResult } from './semantic';
import { CTranslator, TargetLanguage, TranslateResult } from './translator';
import { TACGenerator, TACProgram, Quad, formatQuads } from './ir';
import { Optimizer, AppliedOptimization } from './optimizer';

function programToQuads(program: TACProgram): Quad[] {
  return [...program.globals, ...program.functions.flatMap((f) => f.code)];
}

export interface TargetCodeResult {
  syntaxErrors: SyntaxError[];
  program: TACProgram;
  listing: string;
}

export interface OptimizeResult {
  syntaxErrors: SyntaxError[];
  original: { program: TACProgram; listing: string };
  optimized: { program: TACProgram; listing: string };
  applied: AppliedOptimization[];
  stats: { instructionsBefore: number; instructionsAfter: number; removed: number };
}

@Injectable()
export class CompilerService {

  /** Análisis léxico — sin cambios */
  tokenize(source: string) {
    lexer.reset(source);
    const tokens = [...lexer];
    return tokens.map(token => ({
      type: token.type,
      value: token.value,
      line: token.line,
      col: token.col,
    }));
  }

  /** Análisis sintáctico */
  parse(source: string): { cst: CSTNode; errors: SyntaxError[] } {
    lexer.reset(source);
    const rawTokens: MooToken[] = [...lexer].map(t => ({
      type:  t.type  ?? 'unknown',
      value: t.value,
      line:  t.line  ?? 0,
      col:   t.col   ?? 0,
    }));

    const parser = new CParser(rawTokens);
    const cst = parser.parse();

    return { cst, errors: parser.errors };
  }

  /** Análisis semántico — nuevo */
  analyze(source: string): { cst: CSTNode; syntaxErrors: SyntaxError[]; semantic: SemanticResult } {
    const { cst, errors: syntaxErrors } = this.parse(source);
    const analyzer = new SemanticAnalyzer();
    const semantic = analyzer.analyze(cst);
    return { cst, syntaxErrors, semantic };
  }

  /** Traducción de C a otro lenguaje */
  translate(source: string, target: TargetLanguage): TranslateResult & { syntaxErrors: SyntaxError[] } {
    const validTargets: TargetLanguage[] = ['javascript', 'cpp'];
    if (!validTargets.includes(target)) {
      throw new BadRequestException(`Lenguaje destino inválido. Use: ${validTargets.join(', ')}`);
    }

    const { cst, errors: syntaxErrors } = this.parse(source);
    if (syntaxErrors.length > 0) {
      return {
        code: '',
        target,
        warnings: ['No se puede traducir código con errores sintácticos'],
        syntaxErrors,
      };
    }

    const translator = new CTranslator();
    const result = translator.translate(cst, target);
    return { ...result, syntaxErrors };
  }

  /** Generación de código destino (código de tres direcciones / TAC) */
  generateTarget(source: string): TargetCodeResult {
    const { cst, errors: syntaxErrors } = this.parse(source);
    if (syntaxErrors.length > 0) {
      const empty: TACProgram = { globals: [], functions: [] };
      return { syntaxErrors, program: empty, listing: '' };
    }

    const generator = new TACGenerator();
    const program = generator.generate(cst);
    return { syntaxErrors, program, listing: formatQuads(programToQuads(program)) };
  }

  /** Optimización del código destino generado */
  optimize(source: string): OptimizeResult {
    const { syntaxErrors, program } = this.generateTarget(source);
    const emptyStats = { instructionsBefore: 0, instructionsAfter: 0, removed: 0 };

    if (syntaxErrors.length > 0) {
      const empty: TACProgram = { globals: [], functions: [] };
      return {
        syntaxErrors,
        original: { program: empty, listing: '' },
        optimized: { program: empty, listing: '' },
        applied: [],
        stats: emptyStats,
      };
    }

    const optimizer = new Optimizer();
    const applied: AppliedOptimization[] = [];
    let instructionsBefore = 0;
    let instructionsAfter = 0;

    const globalsResult = optimizer.optimize(program.globals);
    applied.push(...globalsResult.applied);
    instructionsBefore += globalsResult.stats.instructionsBefore;
    instructionsAfter += globalsResult.stats.instructionsAfter;

    const optimizedFunctions = program.functions.map((fn) => {
      const result = optimizer.optimize(fn.code);
      applied.push(...result.applied);
      instructionsBefore += result.stats.instructionsBefore;
      instructionsAfter += result.stats.instructionsAfter;
      return { ...fn, code: result.code };
    });

    const optimizedProgram: TACProgram = { globals: globalsResult.code, functions: optimizedFunctions };

    return {
      syntaxErrors,
      original: { program, listing: formatQuads(programToQuads(program)) },
      optimized: { program: optimizedProgram, listing: formatQuads(programToQuads(optimizedProgram)) },
      applied,
      stats: {
        instructionsBefore,
        instructionsAfter,
        removed: instructionsBefore - instructionsAfter,
      },
    };
  }
}
