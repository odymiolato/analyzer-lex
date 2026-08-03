// ir.ts
// Generador de código destino (código de tres direcciones / TAC)
// Traduce el CST (ya validado semánticamente) a una secuencia de cuádruplas,
// que es la representación clásica de "código objeto" intermedio usada como
// entrada del optimizador y, en última instancia, del backend de un compilador.

import { CSTNode } from './c.parser';

// ─── Cuádrupla ────────────────────────────────────────────────────────────

export interface Quad {
  op: string;
  arg1: string | null;
  arg2: string | null;
  result: string | null;
}

export interface TACFunction {
  name: string;
  params: string[];
  code: Quad[];
}

export interface TACProgram {
  globals: Quad[];
  functions: TACFunction[];
}

const BINARY_OPS = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '&',
  '|',
  '^',
  '<<',
  '>>',
]);
const COMPOUND_ASSIGN_TO_OP: Record<string, string> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '%=': '%',
  '&=': '&',
  '|=': '|',
  '^=': '^',
  '<<=': '<<',
  '>>=': '>>',
};

function q(
  op: string,
  arg1: string | null,
  arg2: string | null,
  result: string | null,
): Quad {
  return { op, arg1, arg2, result };
}

/** Formatea una cuádrupla en una línea de "código de tres direcciones" legible. */
export function formatQuad(quad: Quad): string {
  const { op, arg1, arg2, result } = quad;
  switch (op) {
    case 'func':
      return `func ${result}:`;
    case 'endfunc':
      return `endfunc ${result}`;
    case 'getparam':
      return `${result} = param[${arg2}]`;
    case 'label':
      return `${result}:`;
    case 'goto':
      return `goto ${result}`;
    case 'ifFalse':
      return `ifFalse ${arg1} goto ${result}`;
    case 'ifTrue':
      return `ifTrue ${arg1} goto ${result}`;
    case 'param':
      return `param ${arg1}`;
    case 'call':
      return result
        ? `${result} = call ${arg1}, ${arg2}`
        : `call ${arg1}, ${arg2}`;
    case 'return':
      return arg1 ? `return ${arg1}` : 'return';
    case '=[]':
      return `${result} = ${arg1}[${arg2}]`;
    case '[]=':
      return `${result}[${arg1}] = ${arg2}`;
    case 'decl':
      return `${result} = alloc[${arg2}]`;
    case '=':
      return `${result} = ${arg1}`;
    case 'uminus':
      return `${result} = -${arg1}`;
    case 'not':
      return `${result} = !${arg1}`;
    case 'bnot':
      return `${result} = ~${arg1}`;
    case 'addr':
      return `${result} = &${arg1}`;
    case 'deref':
      return `${result} = *${arg1}`;
    default:
      if (BINARY_OPS.has(op)) return `${result} = ${arg1} ${op} ${arg2}`;
      return `${result} = ${arg1} ${op} ${arg2}`;
  }
}

export function formatQuads(quads: Quad[]): string {
  return quads.map(formatQuad).join('\n');
}

// ─── Contexto de bucle / switch (para break / continue) ──────────────────

interface LoopCtx {
  continueLabel: string | null; // null dentro de un switch (continue lo ignora)
  breakLabel: string;
}

// ─── Generador de código de tres direcciones ─────────────────────────────

export class TACGenerator {
  private tempCount = 0;
  private labelCount = 0;
  private code: Quad[] = [];
  private loopStack: LoopCtx[] = [];

  generate(cst: CSTNode): TACProgram {
    this.tempCount = 0;
    this.labelCount = 0;

    const globals: Quad[] = [];
    const functions: TACFunction[] = [];

    for (const child of cst.children ?? []) {
      if (child.name === 'functionDefinition') {
        functions.push(this.genFunction(child));
      } else {
        this.code = globals;
        this.genStatement(child);
      }
    }

    return { globals, functions };
  }

  private newTemp(): string {
    return `t${++this.tempCount}`;
  }

  private newLabel(): string {
    return `L${++this.labelCount}`;
  }

  private emit(instr: Quad) {
    this.code.push(instr);
  }

  // ── Funciones ────────────────────────────────────────────────────────

  private genFunction(node: CSTNode): TACFunction {
    const children = node.children ?? [];
    const name = children[1]?.image ?? 'func';
    const paramList = children[2];
    const block = children[3];

    const params: string[] = (paramList?.children ?? [])
      .filter((p) => p.name === 'param')
      .map(
        (p) => p.children?.find((c) => c.name === 'identifier')?.image ?? '_',
      );

    this.code = [];
    this.emit(q('func', null, null, name));
    params.forEach((p, i) => this.emit(q('getparam', null, String(i), p)));

    if (block) {
      for (const stmt of block.children ?? []) this.genStatement(stmt);
    }
    this.emit(q('endfunc', null, null, name));

    return { name, params, code: this.code };
  }

  // ── Sentencias ───────────────────────────────────────────────────────

  private genStatement(node: CSTNode) {
    switch (node.name) {
      case 'block':
        for (const c of node.children ?? []) this.genStatement(c);
        return;
      case 'variableDeclaration':
        this.genVarDecl(node);
        return;
      case 'ifStatement':
        this.genIf(node);
        return;
      case 'whileStatement':
        this.genWhile(node);
        return;
      case 'doWhileStatement':
        this.genDoWhile(node);
        return;
      case 'forStatement':
        this.genFor(node);
        return;
      case 'returnStatement': {
        const expr = node.children?.[0];
        if (!expr) {
          this.emit(q('return', null, null, null));
          return;
        }
        this.emit(q('return', this.genExpr(expr), null, null));
        return;
      }
      case 'breakStatement': {
        const ctx = this.loopStack[this.loopStack.length - 1];
        if (ctx) this.emit(q('goto', null, null, ctx.breakLabel));
        return;
      }
      case 'continueStatement': {
        const ctx = [...this.loopStack].reverse().find((c) => c.continueLabel);
        if (ctx?.continueLabel)
          this.emit(q('goto', null, null, ctx.continueLabel));
        return;
      }
      case 'expressionStatement':
        if (node.children?.[0]) this.genExpr(node.children[0]);
        return;
      case 'switchStatement':
        this.genSwitch(node);
        return;
      case 'incompleteDecl':
        return;
      default:
        // Cualquier otro nodo aislado: se evalúa como expresión (defensivo)
        if (node.children) this.genExpr(node);
        return;
    }
  }

  private genVarDecl(node: CSTNode) {
    const children = node.children ?? [];
    let i = 1; // 0 es typeSpecifier
    while (i < children.length) {
      const child = children[i];
      if (child.name !== 'identifier') {
        i++;
        continue;
      }
      const name = child.image ?? '';

      // Dimensión de arreglo opcional: int arr[10]
      if (
        i + 1 < children.length &&
        children[i + 1].name !== 'assign' &&
        children[i + 1].name !== 'identifier'
      ) {
        const dimPlace = this.genExpr(children[i + 1]);
        this.emit(q('decl', null, dimPlace, name));
        i += 2;
        continue;
      }

      if (i + 1 < children.length && children[i + 1].name === 'assign') {
        const initPlace = this.genExpr(children[i + 2]);
        this.emit(q('=', initPlace, null, name));
        i += 3;
        continue;
      }
      i++;
    }
  }

  private genIf(node: CSTNode) {
    const children = node.children ?? [];
    const condPlace = this.genExpr(children[0]);
    const lFalse = this.newLabel();
    this.emit(q('ifFalse', condPlace, null, lFalse));
    this.genStatement(children[1]);

    if (children.length > 2) {
      const lEnd = this.newLabel();
      this.emit(q('goto', null, null, lEnd));
      this.emit(q('label', null, null, lFalse));
      this.genStatement(children[2]);
      this.emit(q('label', null, null, lEnd));
    } else {
      this.emit(q('label', null, null, lFalse));
    }
  }

  private genWhile(node: CSTNode) {
    const children = node.children ?? [];
    const lStart = this.newLabel();
    const lEnd = this.newLabel();

    this.emit(q('label', null, null, lStart));
    const condPlace = this.genExpr(children[0]);
    this.emit(q('ifFalse', condPlace, null, lEnd));

    this.loopStack.push({ continueLabel: lStart, breakLabel: lEnd });
    this.genStatement(children[1]);
    this.loopStack.pop();

    this.emit(q('goto', null, null, lStart));
    this.emit(q('label', null, null, lEnd));
  }

  private genDoWhile(node: CSTNode) {
    const children = node.children ?? [];
    const lStart = this.newLabel();
    const lContinue = this.newLabel();
    const lEnd = this.newLabel();

    this.emit(q('label', null, null, lStart));
    this.loopStack.push({ continueLabel: lContinue, breakLabel: lEnd });
    this.genStatement(children[0]);
    this.loopStack.pop();

    this.emit(q('label', null, null, lContinue));
    const condPlace = this.genExpr(children[1]);
    this.emit(q('ifTrue', condPlace, null, lStart));
    this.emit(q('label', null, null, lEnd));
  }

  private genFor(node: CSTNode) {
    const parts = node.children ?? [];
    let idx = 0;

    if (parts[0]?.name === 'variableDeclaration') {
      this.genVarDecl(parts[0]);
      idx = 1;
    } else if (parts[0]?.name === 'expressionStatement') {
      this.genExpr(parts[0].children![0]);
      idx = 1;
    }

    let condNode: CSTNode | undefined;
    if (parts[idx] && parts[idx].name !== 'block') {
      condNode = parts[idx];
      idx++;
    }
    let updateNode: CSTNode | undefined;
    if (parts[idx] && parts[idx].name !== 'block') {
      updateNode = parts[idx];
      idx++;
    }
    const body = parts[idx];

    const lStart = this.newLabel();
    const lContinue = this.newLabel();
    const lEnd = this.newLabel();

    this.emit(q('label', null, null, lStart));
    if (condNode) {
      const condPlace = this.genExpr(condNode);
      this.emit(q('ifFalse', condPlace, null, lEnd));
    }

    this.loopStack.push({ continueLabel: lContinue, breakLabel: lEnd });
    if (body) this.genStatement(body);
    this.loopStack.pop();

    this.emit(q('label', null, null, lContinue));
    if (updateNode) this.genExpr(updateNode);
    this.emit(q('goto', null, null, lStart));
    this.emit(q('label', null, null, lEnd));
  }

  private genSwitch(node: CSTNode) {
    const children = node.children ?? [];
    const exprPlace = this.genExpr(children[0]);
    const lEnd = this.newLabel();

    type Clause = {
      label: string;
      valuePlace: string | null;
      body: CSTNode[];
      isDefault: boolean;
    };
    const clauses: Clause[] = [];

    for (let i = 1; i < children.length; i++) {
      const clause = children[i];
      if (clause.name === 'caseClause') {
        const valuePlace = this.genExpr(clause.children![0]);
        clauses.push({
          label: this.newLabel(),
          valuePlace,
          body: (clause.children ?? []).slice(1),
          isDefault: false,
        });
      } else if (clause.name === 'defaultClause') {
        clauses.push({
          label: this.newLabel(),
          valuePlace: null,
          body: clause.children ?? [],
          isDefault: true,
        });
      }
    }

    const defaultClause = clauses.find((c) => c.isDefault);
    for (const c of clauses) {
      if (c.isDefault) continue;
      const t = this.newTemp();
      this.emit(q('==', exprPlace, c.valuePlace, t));
      this.emit(q('ifTrue', t, null, c.label));
    }
    this.emit(
      q('goto', null, null, defaultClause ? defaultClause.label : lEnd),
    );

    this.loopStack.push({ continueLabel: null, breakLabel: lEnd });
    for (const c of clauses) {
      this.emit(q('label', null, null, c.label));
      for (const stmt of c.body) this.genStatement(stmt);
    }
    this.loopStack.pop();

    this.emit(q('label', null, null, lEnd));
  }

  // ── Expresiones (devuelven el "lugar" donde queda el valor) ─────────

  private genExpr(node: CSTNode): string {
    switch (node.name) {
      case 'numberLiteral':
      case 'stringLiteral':
      case 'charLiteral':
      case 'booleanLiteral':
      case 'identifier':
        return node.image ?? '';

      case 'groupedExpr':
        return this.genExpr(node.children![0]);

      case 'assignment':
        return this.genAssignment(node);

      case 'binaryExpr':
        return this.genBinary(node);

      case 'ternaryExpr':
        return this.genTernary(node);

      case 'unaryExpr':
        return this.genUnary(node);

      case 'postfixExpr':
        return this.genPostfix(node);

      case 'callExpr':
        return this.genCall(node);

      case 'arrayAccess': {
        const basePlace = this.genExpr(node.children![0]);
        const idxPlace = this.genExpr(node.children![1]);
        const t = this.newTemp();
        this.emit(q('=[]', basePlace, idxPlace, t));
        return t;
      }

      case 'memberAccess': {
        // Structs no soportados por el analizador semántico: mejor esfuerzo
        const basePlace = this.genExpr(node.children![0]);
        const member = node.children![2]?.image ?? '';
        return `${basePlace}.${member}`;
      }

      case 'castExpr':
        return this.genExpr(node.children![1]);

      case 'sizeofExpr': {
        const inner = node.children![0];
        if (inner.name === 'typeSpecifier') {
          return String(this.sizeOfType(inner));
        }
        this.genExpr(inner);
        return '4';
      }

      default:
        // Nodo desconocido: intenta bajar por sus hijos (defensivo)
        if (node.children?.length) return this.genExpr(node.children[0]);
        return node.image ?? '';
    }
  }

  private sizeOfType(typeNode: CSTNode): number {
    const parts = (typeNode.children ?? []).map((c) => c.image ?? '');
    if (parts.includes('pointer') || parts.some((p) => p === '*')) return 8;
    if (parts.includes('double')) return 8;
    if (parts.includes('char') || parts.includes('bool')) return 1;
    if (parts.includes('short')) return 2;
    if (parts.includes('long')) return 8;
    return 4; // int / float / default
  }

  private genAssignment(node: CSTNode): string {
    const [lhs, opNode, rhs] = node.children ?? [];
    const opImg = opNode?.image ?? '=';

    let rhsPlace: string;
    if (opImg === '=') {
      rhsPlace = this.genExpr(rhs);
    } else {
      const lhsValuePlace = this.genExpr(lhs);
      const rhsExprPlace = this.genExpr(rhs);
      const binOp = COMPOUND_ASSIGN_TO_OP[opImg] ?? '+';
      const t = this.newTemp();
      this.emit(q(binOp, lhsValuePlace, rhsExprPlace, t));
      rhsPlace = t;
    }

    return this.storeInto(lhs, rhsPlace);
  }

  /** Genera la escritura hacia el destino de una asignación y devuelve el valor asignado. */
  private storeInto(target: CSTNode, valuePlace: string): string {
    if (target.name === 'identifier') {
      const name = target.image ?? '';
      this.emit(q('=', valuePlace, null, name));
      return name;
    }
    if (target.name === 'arrayAccess') {
      const basePlace = this.genExpr(target.children![0]);
      const idxPlace = this.genExpr(target.children![1]);
      this.emit(q('[]=', idxPlace, valuePlace, basePlace));
      return valuePlace;
    }
    if (target.name === 'unaryExpr' && target.children?.[0]?.image === '*') {
      const ptrPlace = this.genExpr(target.children[1]);
      this.emit(q('storeind', ptrPlace, valuePlace, ptrPlace));
      return valuePlace;
    }
    // Fallback: destino no reconocido, se copia igualmente
    const place = this.genExpr(target);
    this.emit(q('=', valuePlace, null, place));
    return valuePlace;
  }

  private genBinary(node: CSTNode): string {
    const [left, opNode, right] = node.children ?? [];
    const op = opNode?.image ?? '+';

    if (op === '&&' || op === '||')
      return this.genShortCircuit(left, op, right);

    const leftPlace = this.genExpr(left);
    const rightPlace = this.genExpr(right);
    const t = this.newTemp();
    this.emit(q(op, leftPlace, rightPlace, t));
    return t;
  }

  private genShortCircuit(
    left: CSTNode,
    op: '&&' | '||',
    right: CSTNode,
  ): string {
    const result = this.newTemp();
    const lShort = this.newLabel();
    const lEnd = this.newLabel();

    const leftPlace = this.genExpr(left);
    if (op === '&&') {
      this.emit(q('ifFalse', leftPlace, null, lShort));
    } else {
      this.emit(q('ifTrue', leftPlace, null, lShort));
    }

    const rightPlace = this.genExpr(right);
    this.emit(q('=', rightPlace, null, result));
    this.emit(q('goto', null, null, lEnd));

    this.emit(q('label', null, null, lShort));
    this.emit(q('=', op === '&&' ? '0' : '1', null, result));
    this.emit(q('label', null, null, lEnd));

    return result;
  }

  private genTernary(node: CSTNode): string {
    const [cond, thenExpr, elseExpr] = node.children ?? [];
    const condPlace = this.genExpr(cond);
    const result = this.newTemp();
    const lElse = this.newLabel();
    const lEnd = this.newLabel();

    this.emit(q('ifFalse', condPlace, null, lElse));
    const thenPlace = this.genExpr(thenExpr);
    this.emit(q('=', thenPlace, null, result));
    this.emit(q('goto', null, null, lEnd));

    this.emit(q('label', null, null, lElse));
    const elsePlace = this.genExpr(elseExpr);
    this.emit(q('=', elsePlace, null, result));
    this.emit(q('label', null, null, lEnd));

    return result;
  }

  private genUnary(node: CSTNode): string {
    const [opNode, operand] = node.children ?? [];
    const op = opNode?.image ?? '';

    if (op === '++' || op === '--') {
      const place = this.genExpr(operand);
      const t = this.newTemp();
      this.emit(q(op === '++' ? '+' : '-', place, '1', t));
      this.storeInto(operand, t);
      return place;
    }

    if (op === '+') return this.genExpr(operand);

    const place = this.genExpr(operand);
    const t = this.newTemp();
    const opMap: Record<string, string> = {
      '-': 'uminus',
      '!': 'not',
      '~': 'bnot',
      '&': 'addr',
    };
    this.emit(q(opMap[op] ?? 'uminus', place, null, t));
    return t;
  }

  private genPostfix(node: CSTNode): string {
    const [operand, opNode] = node.children ?? [];
    const op = opNode?.image ?? '';
    const place = this.genExpr(operand);
    const original = this.newTemp();
    this.emit(q('=', place, null, original));
    const updated = this.newTemp();
    this.emit(q(op === '++' ? '+' : '-', place, '1', updated));
    this.storeInto(operand, updated);
    return original;
  }

  private genCall(node: CSTNode): string {
    const [callee, argsNode] = node.children ?? [];
    const fnName = callee.image ?? this.genExpr(callee);
    const args = (argsNode?.children ?? []).map((a) => this.genExpr(a));

    for (const a of args) this.emit(q('param', a, null, null));

    const t = this.newTemp();
    this.emit(q('call', fnName, String(args.length), t));
    return t;
  }
}
