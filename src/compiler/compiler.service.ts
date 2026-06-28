import { Injectable, BadRequestException } from '@nestjs/common';
import { lexer } from './lexer';
import { CParser, CSTNode, SyntaxError, MooToken } from './c.parser';
import { SemanticAnalyzer, SemanticResult } from './semantic';
import { CTranslator, TargetLanguage, TranslateResult } from './translator';

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
}
