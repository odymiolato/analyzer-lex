import { Injectable } from '@nestjs/common';
import { lexer } from './lexer';

@Injectable()
export class CompilerService {

  tokenize(source: string) {

    lexer.reset(source);

    const tokens = [...lexer];

    return tokens.map(token => ({
      type: token.type,
      value: token.value,
      line: token.line,
      col: token.col
    }));
  }
}