// c.parser.ts
// Parser sintáctico recursivo-descendente para C
// Adaptado a los tokens del lexer moo (lexer.ts)

export interface CSTNode {
  name: string;
  image?: string;
  tokenType?: string;
  children?: CSTNode[];
}

export interface SyntaxError {
  message: string;
  line: number;
  column: number;
  token: string;
}

// ─── Token shape que produce moo ─────────────────────────
export interface MooToken {
  type: string;   // 'KEYWORD' | 'TYPE' | 'IDENTIFIER' | 'OPERATOR' | 'PUNCTUATION' | ...
  value: string;
  line: number;
  col: number;
}

// ─── Error interno ────────────────────────────────────────
class ParseError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly column: number,
    public readonly token: string,
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ─── Token Stream ─────────────────────────────────────────
class TokenStream {
  readonly tokens: MooToken[];
  pos = 0;

  constructor(tokens: MooToken[]) {
    // Ignorar WS, comentarios y directivas de preprocesador
    this.tokens = tokens.filter(
      (t) => t.type !== 'WS' && t.type !== 'COMMENT' && t.type !== 'PREPROCESSOR',
    );
  }

  peek(): MooToken | null {
    return this.tokens[this.pos] ?? null;
  }

  consume(): MooToken {
    const t = this.tokens[this.pos];
    if (!t) throw new ParseError('Fin de archivo inesperado', 0, 0, 'EOF');
    this.pos++;
    return t;
  }

  /** Consume si el type Y value coinciden */
  expect(type: string, value?: string): MooToken {
    const t = this.peek();
    const got = t ? `'${t.value}' (${t.type})` : 'EOF';
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      const expected = value ? `${type}('${value}')` : type;
      throw new ParseError(
        `Se esperaba ${expected} pero se encontró ${got}`,
        t?.line ?? 0, t?.col ?? 0, t?.value ?? '',
      );
    }
    return this.consume();
  }

  /** Consume si el value coincide (type libre) */
  expectValue(value: string): MooToken {
    const t = this.peek();
    if (!t || t.value !== value) {
      const got = t ? `'${t.value}'` : 'EOF';
      throw new ParseError(
        `Se esperaba '${value}' pero se encontró ${got}`,
        t?.line ?? 0, t?.col ?? 0, t?.value ?? '',
      );
    }
    return this.consume();
  }

  checkValue(...values: string[]): boolean {
    const t = this.peek();
    return t !== null && values.includes(t.value);
  }

  checkType(...types: string[]): boolean {
    const t = this.peek();
    return t !== null && types.includes(t.type);
  }

  isEOF(): boolean {
    return this.pos >= this.tokens.length;
  }
}

// ─── Helpers de nodo ─────────────────────────────────────
function leaf(ruleName: string, token: MooToken): CSTNode {
  return { name: ruleName, image: token.value, tokenType: token.type };
}

function node(name: string, children: CSTNode[]): CSTNode {
  return { name, children };
}

// ─── Parser ───────────────────────────────────────────────
export class CParser {
  private stream: TokenStream;
  public errors: SyntaxError[] = [];

  constructor(tokens: MooToken[]) {
    this.stream = new TokenStream(tokens);
  }

  // ── Entrada ──────────────────────────────────────────────
  parse(): CSTNode {
    const children: CSTNode[] = [];
    while (!this.stream.isEOF()) {
      try {
        children.push(this.statement());
      } catch (e) {
        if (e instanceof ParseError) {
          this.errors.push({ message: e.message, line: e.line, column: e.column, token: e.token });
          this.recover();
        } else throw e;
      }
    }
    return node('program', children);
  }

  // ── Recuperación de pánico ────────────────────────────────
  private recover() {
    const safeValues = new Set([';', '}', 'if', 'while', 'for', 'do', 'return', 'switch']);
    while (!this.stream.isEOF()) {
      const t = this.stream.peek()!;
      if (safeValues.has(t.value) || t.type === 'TYPE') {
        if (t.value === ';' || t.value === '}') this.stream.consume();
        break;
      }
      this.stream.consume();
    }
  }

  // ── Statements ────────────────────────────────────────────
  private statement(): CSTNode {
    const t = this.stream.peek();
    if (!t) throw new ParseError('Se esperaba una declaración', 0, 0, '');

    // TYPE → variable o función
    if (t.type === 'TYPE') return this.typeStartedStatement();

    // KEYWORD
    switch (t.value) {
      case '{':        return this.block();
      case 'if':       return this.ifStatement();
      case 'while':    return this.whileStatement();
      case 'for':      return this.forStatement();
      case 'do':       return this.doWhileStatement();
      case 'return':   return this.returnStatement();
      case 'break':    return this.simpleKeyword('break');
      case 'continue': return this.simpleKeyword('continue');
      case 'switch':   return this.switchStatement();
      default:         return this.expressionStatement();
    }
  }

  private simpleKeyword(kw: string): CSTNode {
    const t = this.stream.expectValue(kw);
    this.stream.expectValue(';');
    return node(kw + 'Statement', [leaf('keyword', t)]);
  }

  // Consume uno o varios TYPE consecutivos (ej: const unsigned int)
  private typeSpecifier(): CSTNode {
    const parts: CSTNode[] = [];
    while (!this.stream.isEOF() && this.stream.checkType('TYPE')) {
      parts.push(leaf('typeToken', this.stream.consume()));
    }
    // Puntero(s) inmediatos: int *p
    while (this.stream.checkValue('*')) {
      parts.push(leaf('pointer', this.stream.consume()));
    }
    if (parts.length === 0) {
      const t = this.stream.peek();
      throw new ParseError('Se esperaba un tipo de dato', t?.line ?? 0, t?.col ?? 0, t?.value ?? '');
    }
    return node('typeSpecifier', parts);
  }

  private typeStartedStatement(): CSTNode {
    const typeNode = this.typeSpecifier();
    const t = this.stream.peek();

    if (!t || t.type !== 'IDENTIFIER') {
      // typedef, struct sin nombre, etc.
      this.stream.expectValue(';');
      return node('incompleteDecl', [typeNode]);
    }

    const id = this.stream.consume(); // IDENTIFIER

    // Función si le sigue '('
    if (this.stream.checkValue('(')) {
      return this.functionDefinition(typeNode, id);
    }
    return this.variableDeclaration(typeNode, id);
  }

  private variableDeclaration(typeNode: CSTNode, idToken: MooToken): CSTNode {
    const children: CSTNode[] = [typeNode, leaf('identifier', idToken)];

    // Arreglo: int arr[10]
    while (this.stream.checkValue('[')) {
      this.stream.consume();
      if (!this.stream.checkValue(']')) children.push(this.expression());
      this.stream.expectValue(']');
    }

    // Inicialización: int x = 5
    if (this.stream.checkValue('=')) {
      children.push(leaf('assign', this.stream.consume()));
      children.push(this.expression());
    }

    // Declaraciones múltiples: int a = 1, b = 2;
    while (this.stream.checkValue(',')) {
      this.stream.consume();
      const nextId = this.stream.expect('IDENTIFIER');
      children.push(leaf('identifier', nextId));
      if (this.stream.checkValue('=')) {
        children.push(leaf('assign', this.stream.consume()));
        children.push(this.expression());
      }
    }

    this.stream.expectValue(';');
    return node('variableDeclaration', children);
  }

  private functionDefinition(typeNode: CSTNode, idToken: MooToken): CSTNode {
    const children: CSTNode[] = [typeNode, leaf('identifier', idToken)];
    this.stream.expectValue('(');
    children.push(this.paramList());
    this.stream.expectValue(')');
    children.push(this.block());
    return node('functionDefinition', children);
  }

  private paramList(): CSTNode {
    const children: CSTNode[] = [];
    if (this.stream.checkValue(')')) return node('paramList', children);

    children.push(this.param());
    while (this.stream.checkValue(',')) {
      this.stream.consume();
      if (this.stream.checkValue('...')) {
        children.push(leaf('varargs', this.stream.consume()));
        break;
      }
      children.push(this.param());
    }
    return node('paramList', children);
  }

  private param(): CSTNode {
    const typeNode = this.typeSpecifier();
    const children: CSTNode[] = [typeNode];
    if (this.stream.checkType('IDENTIFIER')) {
      children.push(leaf('identifier', this.stream.consume()));
    }
    return node('param', children);
  }

  private block(): CSTNode {
    this.stream.expectValue('{');
    const children: CSTNode[] = [];
    while (!this.stream.isEOF() && !this.stream.checkValue('}')) {
      try {
        children.push(this.statement());
      } catch (e) {
        if (e instanceof ParseError) {
          this.errors.push({ message: e.message, line: e.line, column: e.column, token: e.token });
          this.recover();
        } else throw e;
      }
    }
    this.stream.expectValue('}');
    return node('block', children);
  }

  private ifStatement(): CSTNode {
    const children: CSTNode[] = [];
    this.stream.expectValue('if');
    this.stream.expectValue('(');
    children.push(this.expression());
    this.stream.expectValue(')');
    children.push(this.block());

    if (this.stream.checkValue('else')) {
      this.stream.consume();
      children.push(this.stream.checkValue('if') ? this.ifStatement() : this.block());
    }
    return node('ifStatement', children);
  }

  private whileStatement(): CSTNode {
    this.stream.expectValue('while');
    this.stream.expectValue('(');
    const cond = this.expression();
    this.stream.expectValue(')');
    return node('whileStatement', [cond, this.block()]);
  }

  private doWhileStatement(): CSTNode {
    this.stream.expectValue('do');
    const body = this.block();
    this.stream.expectValue('while');
    this.stream.expectValue('(');
    const cond = this.expression();
    this.stream.expectValue(')');
    this.stream.expectValue(';');
    return node('doWhileStatement', [body, cond]);
  }

  private forStatement(): CSTNode {
    const children: CSTNode[] = [];
    this.stream.expectValue('for');
    this.stream.expectValue('(');

    // Init
    if (!this.stream.checkValue(';')) {
      if (this.stream.checkType('TYPE')) {
        const typeNode = this.typeSpecifier();
        const id = this.stream.expect('IDENTIFIER');
        children.push(this.variableDeclaration(typeNode, id));
      } else {
        children.push(this.expressionStatement());
      }
    } else {
      this.stream.consume();
    }

    // Condición
    if (!this.stream.checkValue(';')) children.push(this.expression());
    this.stream.expectValue(';');

    // Actualización
    if (!this.stream.checkValue(')')) children.push(this.expression());
    this.stream.expectValue(')');

    children.push(this.block());
    return node('forStatement', children);
  }

  private returnStatement(): CSTNode {
    this.stream.expectValue('return');
    const children: CSTNode[] = [];
    if (!this.stream.checkValue(';')) children.push(this.expression());
    this.stream.expectValue(';');
    return node('returnStatement', children);
  }

  private switchStatement(): CSTNode {
    this.stream.expectValue('switch');
    this.stream.expectValue('(');
    const expr = this.expression();
    this.stream.expectValue(')');
    this.stream.expectValue('{');
    const children: CSTNode[] = [expr];

    while (!this.stream.isEOF() && !this.stream.checkValue('}')) {
      if (this.stream.checkValue('case')) {
        this.stream.consume();
        const caseVal = this.expression();
        this.stream.expectValue(':');
        const stmts: CSTNode[] = [];
        while (!this.stream.isEOF() &&
               !this.stream.checkValue('case') &&
               !this.stream.checkValue('default') &&
               !this.stream.checkValue('}')) {
          stmts.push(this.statement());
        }
        children.push(node('caseClause', [caseVal, ...stmts]));
      } else if (this.stream.checkValue('default')) {
        this.stream.consume();
        this.stream.expectValue(':');
        const stmts: CSTNode[] = [];
        while (!this.stream.isEOF() && !this.stream.checkValue('}')) {
          stmts.push(this.statement());
        }
        children.push(node('defaultClause', stmts));
      } else {
        children.push(this.statement());
      }
    }

    this.stream.expectValue('}');
    return node('switchStatement', children);
  }

  private expressionStatement(): CSTNode {
    const expr = this.expression();
    this.stream.expectValue(';');
    return node('expressionStatement', [expr]);
  }

  // ── Expresiones ──────────────────────────────────────────
  private expression(): CSTNode { return this.assignment(); }

  private assignment(): CSTNode {
    const left = this.ternary();
    const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='];
    if (!this.stream.isEOF() && assignOps.includes(this.stream.peek()?.value ?? '')) {
      const op = this.stream.consume();
      return node('assignment', [left, leaf('op', op), this.assignment()]);
    }
    return left;
  }

  private ternary(): CSTNode {
    const cond = this.logicalOr();
    if (this.stream.checkValue('?')) {
      this.stream.consume();
      const then = this.expression();
      this.stream.expectValue(':');
      return node('ternaryExpr', [cond, then, this.expression()]);
    }
    return cond;
  }

  private logicalOr(): CSTNode      { return this.leftAssoc(() => this.logicalAnd(),     ['||']); }
  private logicalAnd(): CSTNode     { return this.leftAssoc(() => this.bitwiseOr(),      ['&&']); }
  private bitwiseOr(): CSTNode      { return this.leftAssoc(() => this.bitwiseXor(),     ['|']);  }
  private bitwiseXor(): CSTNode     { return this.leftAssoc(() => this.bitwiseAnd(),     ['^']);  }
  private bitwiseAnd(): CSTNode     { return this.leftAssoc(() => this.equality(),       ['&']);  }
  private equality(): CSTNode       { return this.leftAssoc(() => this.comparison(),     ['==', '!=']); }
  private comparison(): CSTNode     { return this.leftAssoc(() => this.shift(),          ['<', '>', '<=', '>=']); }
  private shift(): CSTNode          { return this.leftAssoc(() => this.additive(),       ['<<', '>>']); }
  private additive(): CSTNode       { return this.leftAssoc(() => this.multiplicative(), ['+', '-']); }
  private multiplicative(): CSTNode { return this.leftAssoc(() => this.unary(),          ['*', '/', '%']); }

  private leftAssoc(sub: () => CSTNode, ops: string[]): CSTNode {
    let left = sub();
    while (!this.stream.isEOF() && ops.includes(this.stream.peek()?.value ?? '')) {
      const op = this.stream.consume();
      left = node('binaryExpr', [left, leaf('op', op), sub()]);
    }
    return left;
  }

  private unary(): CSTNode {
    const t = this.stream.peek();
    if (t && ['!', '-', '+', '~', '++', '--', '&'].includes(t.value)) {
      const op = this.stream.consume();
      return node('unaryExpr', [leaf('op', op), this.unary()]);
    }
    // Cast: (int) expr
    if (t?.value === '(') {
      const savedPos = this.stream.pos;
      try {
        this.stream.consume(); // (
        if (this.stream.checkType('TYPE')) {
          const typeNode = this.typeSpecifier();
          this.stream.expectValue(')');
          return node('castExpr', [typeNode, this.unary()]);
        }
        this.stream.pos = savedPos;
      } catch {
        this.stream.pos = savedPos;
      }
    }
    return this.postfix();
  }

  private postfix(): CSTNode {
    let base = this.primary();
    while (!this.stream.isEOF()) {
      const t = this.stream.peek()!;
      if (t.value === '++' || t.value === '--') {
        base = node('postfixExpr', [base, leaf('op', this.stream.consume())]);
      } else if (t.value === '[') {
        this.stream.consume();
        const idx = this.expression();
        this.stream.expectValue(']');
        base = node('arrayAccess', [base, idx]);
      } else if (t.value === '(') {
        this.stream.consume();
        const args = this.argList();
        this.stream.expectValue(')');
        base = node('callExpr', [base, args]);
      } else if (t.value === '.' || t.value === '->') {
        const op = this.stream.consume();
        const member = this.stream.expect('IDENTIFIER');
        base = node('memberAccess', [base, leaf('op', op), leaf('identifier', member)]);
      } else {
        break;
      }
    }
    return base;
  }

  private argList(): CSTNode {
    const children: CSTNode[] = [];
    if (this.stream.checkValue(')')) return node('argList', children);
    children.push(this.expression());
    while (this.stream.checkValue(',')) {
      this.stream.consume();
      children.push(this.expression());
    }
    return node('argList', children);
  }

  private primary(): CSTNode {
    const t = this.stream.peek();
    if (!t) throw new ParseError('Fin de archivo inesperado en expresión', 0, 0, 'EOF');

    if (t.type === 'NUMBER')    return leaf('numberLiteral',  this.stream.consume());
    if (t.type === 'STRING')    return leaf('stringLiteral',  this.stream.consume());
    if (t.type === 'CHAR')      return leaf('charLiteral',    this.stream.consume());
    if (t.type === 'BOOLEAN')   return leaf('booleanLiteral', this.stream.consume());
    if (t.type === 'IDENTIFIER') return leaf('identifier',    this.stream.consume());

    if (t.value === 'sizeof') {
      this.stream.consume();
      this.stream.expectValue('(');
      const inner = this.stream.checkType('TYPE') ? this.typeSpecifier() : this.expression();
      this.stream.expectValue(')');
      return node('sizeofExpr', [inner]);
    }

    if (t.value === '(') {
      this.stream.consume();
      const inner = this.expression();
      this.stream.expectValue(')');
      return node('groupedExpr', [inner]);
    }

    throw new ParseError(
      `Token inesperado: '${t.value}' (${t.type})`,
      t.line, t.col, t.value,
    );
  }
}
