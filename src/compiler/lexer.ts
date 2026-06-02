import moo from 'moo';

export const lexer = moo.compile({

  WS: {
    match: /[ \t\r\n]+/,
    lineBreaks: true,
  },

  COMMENT: [
    /\/\/.*$/,
    /\/\*[^]*?\*\//
  ],

  PREPROCESSOR: /#[a-zA-Z_][a-zA-Z0-9_]*/,

  STRING: {
    match: /"(?:\\.|[^"\\])*"/,
    lineBreaks: false,
  },

  CHAR: {
    match: /'(?:\\.|[^'\\])'/,
  },

  NUMBER: {
    match: /(?:\d+\.\d+|\d+)(?:[eE][+-]?\d+)?/,
  },

  KEYWORD: [
    'if',
    'else',
    'while',
    'for',
    'do',
    'switch',
    'case',
    'default',
    'break',
    'continue',
    'return',
    'goto',
    'sizeof'
  ],

  TYPE: [
    'int',
    'float',
    'double',
    'char',
    'void',
    'short',
    'long',
    'signed',
    'unsigned',
    'struct',
    'union',
    'enum',
    'typedef',
    'const',
    'volatile',
    'static',
    'extern',
    'register',
    'auto'
  ],

  BOOLEAN: [
    'true',
    'false'
  ],

  OPERATOR: [
    '>>=',
    '<<=',
    '++',
    '--',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '==',
    '!=',
    '<=',
    '>=',
    '&&',
    '||',
    '<<',
    '>>',
    '->',

    '=',

    '+',
    '-',
    '*',
    '/',
    '%',

    '<',
    '>',

    '!',

    '&',
    '|',
    '^',
    '~',

    '?'
  ],

  PUNCTUATION: [
    '(',
    ')',
    '{',
    '}',
    '[',
    ']',
    ';',
    ',',
    '.',
    ':'
  ],

  IDENTIFIER: /[a-zA-Z_][a-zA-Z0-9_]*/,

  ERROR: /./
});