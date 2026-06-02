import {
  createToken,
  CstParser
} from 'chevrotain';

export const Int = createToken({
  name: 'Int',
  pattern: /int/
});

export const Identifier = createToken({
  name: 'Identifier',
  pattern: /[a-zA-Z_$][a-zA-Z0-9_$]*/
});

export const Assign = createToken({
  name: 'Assign',
  pattern: /=/
});

export const NumberLiteral = createToken({
  name: 'NumberLiteral',
  pattern: /\d+/
});

export const SemiColon = createToken({
  name: 'SemiColon',
  pattern: /;/
});

const allTokens = [
  Int,
  Identifier,
  Assign,
  NumberLiteral,
  SemiColon
];

export class MiniCParser extends CstParser {

  constructor() {
    super(allTokens);

    const $ = this;

    $.RULE('variableDeclaration', () => {
      $.CONSUME(Int);
      $.CONSUME(Identifier);
      $.CONSUME(Assign);
      $.CONSUME(NumberLiteral);
      $.CONSUME(SemiColon);
    });

    this.performSelfAnalysis();
  }
}