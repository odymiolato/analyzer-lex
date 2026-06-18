// semantic.ts
// Analizador semántico para C — tabla de símbolos, verificación de tipos, ámbito

import { CSTNode } from './c.parser';

// ─── Tipos del sistema de tipos C ────────────────────────────────────────────

export type CType =
  | 'int' | 'float' | 'double' | 'char' | 'void' | 'bool'
  | 'long' | 'short' | 'unsigned' | 'signed'
  | { kind: 'pointer'; base: CType }
  | { kind: 'array'; base: CType; size?: number }
  | { kind: 'function'; returnType: CType; params: CType[] }
  | 'unknown';

function typeToString(t: CType): string {
  if (typeof t === 'string') return t;
  if (t.kind === 'pointer') return `${typeToString(t.base)}*`;
  if (t.kind === 'array')   return `${typeToString(t.base)}[]`;
  if (t.kind === 'function')
    return `${typeToString(t.returnType)}(${t.params.map(typeToString).join(', ')})`;
  return 'unknown';
}

function isNumeric(t: CType): boolean {
  return ['int','float','double','long','short','unsigned','signed','char','bool'].includes(t as string);
}

function typesCompatible(a: CType, b: CType): boolean {
  if (a === 'unknown' || b === 'unknown') return true; // evitar error-cascade
  if (a === b) return true;
  if (isNumeric(a) && isNumeric(b)) return true;
  if (typeof a === 'object' && typeof b === 'object' && a.kind === b.kind) {
    if (a.kind === 'pointer' && b.kind === 'pointer') return typesCompatible(a.base, b.base);
    if (a.kind === 'array'   && b.kind === 'array')   return typesCompatible(a.base, b.base);
  }
  // void* compatible con cualquier puntero
  if (typeof a === 'object' && a.kind === 'pointer' && a.base === 'void') return true;
  if (typeof b === 'object' && b.kind === 'pointer' && b.base === 'void') return true;
  return false;
}

// ─── Símbolo en la tabla ──────────────────────────────────────────────────────

export interface Symbol {
  name: string;
  type: CType;
  kind: 'variable' | 'function' | 'parameter';
  scopeLevel: number;
  line: number;
  column: number;
  used: boolean;
  initialized: boolean;
}

// ─── Error semántico ──────────────────────────────────────────────────────────

export interface SemanticError {
  message: string;
  line: number;
  column: number;
  severity: 'error' | 'warning';
}

// ─── Tabla de símbolos con ámbitos anidados ───────────────────────────────────

class SymbolTable {
  private scopes: Map<string, Symbol>[] = [];

  enterScope() { this.scopes.push(new Map()); }

  exitScope(): Map<string, Symbol> {
    return this.scopes.pop()!;
  }

  get level() { return this.scopes.length; }

  define(sym: Symbol): boolean {
    const current = this.scopes[this.scopes.length - 1];
    if (current.has(sym.name)) return false; // ya declarado en este ámbito
    current.set(sym.name, sym);
    return true;
  }

  lookup(name: string): Symbol | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const sym = this.scopes[i].get(name);
      if (sym) return sym;
    }
    return undefined;
  }

  /** Símbolos del ámbito actual (para detectar no-usados) */
  currentScope(): Map<string, Symbol> {
    return this.scopes[this.scopes.length - 1] ?? new Map();
  }
}

// ─── Analizador semántico ─────────────────────────────────────────────────────

export interface SemanticResult {
  errors: SemanticError[];
  warnings: SemanticError[];
  symbolTable: SymbolTableEntry[];
}

export interface SymbolTableEntry {
  name: string;
  type: string;
  kind: string;
  scopeLevel: number;
  line: number;
  column: number;
  initialized: boolean;
  used: boolean;
}

export class SemanticAnalyzer {
  private table = new SymbolTable();
  private errors: SemanticError[] = [];
  private currentFunctionReturn: CType = 'void';
  private insideLoop = 0;
  private insideSwitch = 0;

  analyze(cst: CSTNode): SemanticResult {
    // Ámbito global
    this.table.enterScope();
    this.registerBuiltins();
    this.visitNode(cst);
    const globalScope = this.table.exitScope();

    // Detectar símbolos no usados en ámbito global
    for (const sym of globalScope.values()) {
      if (sym.kind === 'variable' && !sym.used) {
        this.warn(`Variable global '${sym.name}' declarada pero nunca usada`, sym.line, sym.column);
      }
    }

    const allSymbols: SymbolTableEntry[] = [];
    for (const sym of globalScope.values()) {
      allSymbols.push({
        name: sym.name,
        type: typeToString(sym.type),
        kind: sym.kind,
        scopeLevel: sym.scopeLevel,
        line: sym.line,
        column: sym.column,
        initialized: sym.initialized,
        used: sym.used,
      });
    }

    return {
      errors: this.errors.filter(e => e.severity === 'error'),
      warnings: this.errors.filter(e => e.severity === 'warning'),
      symbolTable: allSymbols,
    };
  }

  // ── Registro de funciones built-in ──────────────────────────────────────────
  private registerBuiltins() {
    const builtins: { name: string; type: CType }[] = [
      { name: 'printf',  type: { kind: 'function', returnType: 'int', params: [] } },
      { name: 'scanf',   type: { kind: 'function', returnType: 'int', params: [] } },
      { name: 'malloc',  type: { kind: 'function', returnType: { kind: 'pointer', base: 'void' }, params: ['int'] } },
      { name: 'free',    type: { kind: 'function', returnType: 'void', params: [{ kind: 'pointer', base: 'void' }] } },
      { name: 'strlen',  type: { kind: 'function', returnType: 'int', params: [{ kind: 'pointer', base: 'char' }] } },
      { name: 'strcpy',  type: { kind: 'function', returnType: { kind: 'pointer', base: 'char' }, params: [] } },
      { name: 'strcmp',  type: { kind: 'function', returnType: 'int', params: [] } },
      { name: 'strcat',  type: { kind: 'function', returnType: { kind: 'pointer', base: 'char' }, params: [] } },
      { name: 'puts',    type: { kind: 'function', returnType: 'int', params: [] } },
      { name: 'gets',    type: { kind: 'function', returnType: { kind: 'pointer', base: 'char' }, params: [] } },
      { name: 'atoi',    type: { kind: 'function', returnType: 'int', params: [] } },
      { name: 'atof',    type: { kind: 'function', returnType: 'double', params: [] } },
      { name: 'exit',    type: { kind: 'function', returnType: 'void', params: ['int'] } },
      { name: 'abs',     type: { kind: 'function', returnType: 'int', params: ['int'] } },
      { name: 'sqrt',    type: { kind: 'function', returnType: 'double', params: ['double'] } },
      { name: 'pow',     type: { kind: 'function', returnType: 'double', params: ['double', 'double'] } },
      { name: 'NULL',    type: { kind: 'pointer', base: 'void' } },
      { name: 'true',    type: 'bool' },
      { name: 'false',   type: 'bool' },
    ];
    for (const b of builtins) {
      this.table.define({ name: b.name, type: b.type, kind: 'variable', scopeLevel: 0, line: 0, column: 0, used: true, initialized: true });
    }
  }

  // ── Error helpers ────────────────────────────────────────────────────────────
  private error(msg: string, line: number, col: number) {
    this.errors.push({ message: msg, line, column: col, severity: 'error' });
  }

  private warn(msg: string, line: number, col: number) {
    this.errors.push({ message: msg, line, column: col, severity: 'warning' });
  }

  // ── Dispatcher ───────────────────────────────────────────────────────────────
  private visitNode(node: CSTNode): CType {
    switch (node.name) {
      case 'program':             return this.visitChildren(node);
      case 'block':               return this.visitBlock(node);
      case 'variableDeclaration': return this.visitVarDecl(node);
      case 'functionDefinition':  return this.visitFuncDef(node);
      case 'ifStatement':         return this.visitIf(node);
      case 'whileStatement':      return this.visitWhile(node);
      case 'doWhileStatement':    return this.visitDoWhile(node);
      case 'forStatement':        return this.visitFor(node);
      case 'returnStatement':     return this.visitReturn(node);
      case 'switchStatement':     return this.visitSwitch(node);
      case 'caseClause':          return this.visitCaseClause(node);
      case 'defaultClause':       return this.visitChildren(node);
      case 'expressionStatement': return this.visitChildren(node);
      case 'breakStatement':      return this.visitBreak(node);
      case 'continueStatement':   return this.visitContinue(node);
      case 'assignment':          return this.visitAssignment(node);
      case 'binaryExpr':          return this.visitBinaryExpr(node);
      case 'unaryExpr':           return this.visitUnaryExpr(node);
      case 'postfixExpr':         return this.visitPostfix(node);
      case 'ternaryExpr':         return this.visitTernary(node);
      case 'callExpr':            return this.visitCallExpr(node);
      case 'arrayAccess':         return this.visitArrayAccess(node);
      case 'memberAccess':        return 'unknown'; // struct no implementado aún
      case 'castExpr':            return this.visitCast(node);
      case 'sizeofExpr':          return 'int';
      case 'groupedExpr':         return node.children ? this.visitNode(node.children[0]) : 'unknown';
      case 'identifier':          return this.visitIdentifier(node);
      case 'numberLiteral':       return this.inferNumberType(node.image ?? '');
      case 'stringLiteral':       return { kind: 'pointer', base: 'char' };
      case 'charLiteral':         return 'char';
      case 'booleanLiteral':      return 'bool';
      default:                    return this.visitChildren(node);
    }
  }

  private visitChildren(node: CSTNode): CType {
    let last: CType = 'void';
    for (const child of node.children ?? []) {
      last = this.visitNode(child);
    }
    return last;
  }

  // ── Bloque con nuevo ámbito ──────────────────────────────────────────────────
  private visitBlock(node: CSTNode): CType {
    this.table.enterScope();
    this.visitChildren(node);
    const scope = this.table.exitScope();

    // Variables locales no usadas
    for (const sym of scope.values()) {
      if ((sym.kind === 'variable' || sym.kind === 'parameter') && !sym.used) {
        this.warn(`Variable '${sym.name}' declarada pero nunca usada`, sym.line, sym.column);
      }
    }
    return 'void';
  }

  // ── Declaración de variable ──────────────────────────────────────────────────
  private visitVarDecl(node: CSTNode): CType {
    const children = node.children ?? [];
    const typeNode = children.find(c => c.name === 'typeSpecifier');
    if (!typeNode) return 'void';

    const baseType = this.extractType(typeNode);
    let i = 1; // índice en children después del typeSpecifier

    while (i < children.length) {
      const child = children[i];
      if (child.name !== 'identifier') { i++; continue; }

      const name = child.image ?? '';
      const line = this.getLine(child);
      const col  = this.getCol(child);

      // Buscar si le sigue un '=' (inicialización)
      let initialized = false;
      let initType: CType = 'unknown';
      if (i + 1 < children.length && children[i + 1].name === 'assign') {
        initialized = true;
        if (i + 2 < children.length) {
          initType = this.visitNode(children[i + 2]);
        }
        i += 3;
      } else {
        i++;
      }

      // Compatibilidad de tipos en inicialización
      if (initialized && !typesCompatible(baseType, initType)) {
        this.error(
          `Incompatibilidad de tipos: no se puede asignar '${typeToString(initType)}' a '${typeToString(baseType)}'`,
          line, col,
        );
      }

      const ok = this.table.define({
        name, type: baseType, kind: 'variable',
        scopeLevel: this.table.level, line, column: col,
        used: false, initialized,
      });

      if (!ok) {
        this.error(`Variable '${name}' ya fue declarada en este ámbito`, line, col);
      }
    }
    return 'void';
  }

  // ── Definición de función ────────────────────────────────────────────────────
  private visitFuncDef(node: CSTNode): CType {
    const children = node.children ?? [];
    const typeNode = children.find(c => c.name === 'typeSpecifier');
    const idNode   = children.find(c => c.name === 'identifier');
    const paramListNode = children.find(c => c.name === 'paramList');
    const blockNode     = children.find(c => c.name === 'block');

    if (!typeNode || !idNode) return 'void';

    const returnType = this.extractType(typeNode);
    const name = idNode.image ?? '';
    const line = this.getLine(idNode);
    const col  = this.getCol(idNode);

    // Extraer tipos de parámetros
    const paramTypes: CType[] = [];
    for (const param of paramListNode?.children ?? []) {
      if (param.name === 'param') {
        const pType = this.extractType(param.children?.find(c => c.name === 'typeSpecifier'));
        paramTypes.push(pType);
      }
    }

    const funcType: CType = { kind: 'function', returnType, params: paramTypes };
    const ok = this.table.define({
      name, type: funcType, kind: 'function',
      scopeLevel: this.table.level, line, column: col,
      used: false, initialized: true,
    });

    if (!ok) {
      this.error(`Función '${name}' ya fue declarada en este ámbito`, line, col);
    }

    // Analizar cuerpo en nuevo ámbito con parámetros registrados
    const prevReturn = this.currentFunctionReturn;
    this.currentFunctionReturn = returnType;

    this.table.enterScope();

    // Registrar parámetros en el ámbito de la función
    for (const param of paramListNode?.children ?? []) {
      if (param.name !== 'param') continue;
      const pTypeNode = param.children?.find(c => c.name === 'typeSpecifier');
      const pIdNode   = param.children?.find(c => c.name === 'identifier');
      if (!pIdNode) continue;
      const pType = this.extractType(pTypeNode);
      const pName = pIdNode.image ?? '';
      this.table.define({
        name: pName, type: pType, kind: 'parameter',
        scopeLevel: this.table.level, line: this.getLine(pIdNode), column: this.getCol(pIdNode),
        used: false, initialized: true,
      });
    }

    // Visitar el bloque sin que visitBlock abra otro ámbito
    if (blockNode) {
      for (const child of blockNode.children ?? []) {
        this.visitNode(child);
      }
    }

    const funcScope = this.table.exitScope();
    for (const sym of funcScope.values()) {
      if (!sym.used && sym.kind === 'parameter') {
        this.warn(`Parámetro '${sym.name}' no utilizado en función '${name}'`, sym.line, sym.column);
      }
    }

    this.currentFunctionReturn = prevReturn;
    return 'void';
  }

  // ── Sentencias de control ────────────────────────────────────────────────────
  private visitIf(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children[0]) {
      const condType = this.visitNode(children[0]);
      if (condType === 'void') {
        this.error('La condición del if no puede ser de tipo void', this.getLine(children[0]), this.getCol(children[0]));
      }
    }
    for (let i = 1; i < children.length; i++) this.visitNode(children[i]);
    return 'void';
  }

  private visitWhile(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children[0]) {
      const condType = this.visitNode(children[0]);
      if (condType === 'void') {
        this.error('La condición del while no puede ser de tipo void', this.getLine(children[0]), this.getCol(children[0]));
      }
    }
    this.insideLoop++;
    if (children[1]) this.visitNode(children[1]);
    this.insideLoop--;
    return 'void';
  }

  private visitDoWhile(node: CSTNode): CType {
    const children = node.children ?? [];
    this.insideLoop++;
    if (children[0]) this.visitNode(children[0]);
    this.insideLoop--;
    if (children[1]) {
      const condType = this.visitNode(children[1]);
      if (condType === 'void') {
        this.error('La condición del do-while no puede ser de tipo void', this.getLine(children[1]), this.getCol(children[1]));
      }
    }
    return 'void';
  }

  private visitFor(node: CSTNode): CType {
    this.table.enterScope();
    this.insideLoop++;
    this.visitChildren(node);
    this.insideLoop--;
    const scope = this.table.exitScope();
    for (const sym of scope.values()) {
      if (!sym.used) {
        this.warn(`Variable '${sym.name}' declarada en for pero nunca usada`, sym.line, sym.column);
      }
    }
    return 'void';
  }

  private visitReturn(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children.length === 0) {
      if (this.currentFunctionReturn !== 'void') {
        this.warn(`Función con tipo de retorno '${typeToString(this.currentFunctionReturn)}' retorna sin valor`, 0, 0);
      }
      return 'void';
    }
    const retType = this.visitNode(children[0]);
    if (this.currentFunctionReturn === 'void' && retType !== 'void') {
      this.error(`Función void no puede retornar un valor`, this.getLine(children[0]), this.getCol(children[0]));
    } else if (!typesCompatible(this.currentFunctionReturn, retType)) {
      this.error(
        `Tipo de retorno incompatible: se esperaba '${typeToString(this.currentFunctionReturn)}' pero se encontró '${typeToString(retType)}'`,
        this.getLine(children[0]), this.getCol(children[0]),
      );
    }
    return retType;
  }

  private visitSwitch(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children[0]) {
      const exprType = this.visitNode(children[0]);
      if (!isNumeric(exprType)) {
        this.error(`La expresión del switch debe ser de tipo entero, se encontró '${typeToString(exprType)}'`, this.getLine(children[0]), this.getCol(children[0]));
      }
    }
    this.insideSwitch++;
    for (let i = 1; i < children.length; i++) this.visitNode(children[i]);
    this.insideSwitch--;
    return 'void';
  }

  private visitCaseClause(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children[0]) {
      const caseType = this.visitNode(children[0]);
      if (!isNumeric(caseType) && caseType !== 'char') {
        this.error(`El valor del case debe ser una constante entera`, this.getLine(children[0]), this.getCol(children[0]));
      }
    }
    for (let i = 1; i < children.length; i++) this.visitNode(children[i]);
    return 'void';
  }

  private visitBreak(node: CSTNode): CType {
    if (this.insideLoop === 0 && this.insideSwitch === 0) {
      this.error(`'break' fuera de un bucle o switch`, this.getLine(node), this.getCol(node));
    }
    return 'void';
  }

  private visitContinue(node: CSTNode): CType {
    if (this.insideLoop === 0) {
      this.error(`'continue' fuera de un bucle`, this.getLine(node), this.getCol(node));
    }
    return 'void';
  }

  // ── Expresiones ──────────────────────────────────────────────────────────────
  private visitAssignment(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children.length < 3) return 'unknown';
    const leftType  = this.visitNode(children[0]);
    const rightType = this.visitNode(children[2]);
    const op        = children[1].image ?? '=';

    if (!typesCompatible(leftType, rightType)) {
      this.error(
        `Asignación '${op}' incompatible: no se puede asignar '${typeToString(rightType)}' a '${typeToString(leftType)}'`,
        this.getLine(children[1]), this.getCol(children[1]),
      );
    }
    // Marcar como inicializado si es una variable en el lado izquierdo
    if (children[0].name === 'identifier') {
      const sym = this.table.lookup(children[0].image ?? '');
      if (sym) sym.initialized = true;
    }
    return leftType;
  }

  private visitBinaryExpr(node: CSTNode): CType {
    const children = node.children ?? [];
    if (children.length < 3) return 'unknown';
    const leftType  = this.visitNode(children[0]);
    const op        = children[1].image ?? '';
    const rightType = this.visitNode(children[2]);

    // Operadores relacionales siempre producen bool
    if (['==','!=','<','>','<=','>=','&&','||'].includes(op)) return 'bool';

    // Operaciones aritméticas: verificar tipos compatibles
    if (['+','-','*','/','%'].includes(op)) {
      if (!isNumeric(leftType) || !isNumeric(rightType)) {
        // Excepción: puntero + int es válido
        const ptrArith =
          (typeof leftType  === 'object' && leftType.kind  === 'pointer' && isNumeric(rightType)) ||
          (typeof rightType === 'object' && rightType.kind === 'pointer' && isNumeric(leftType));
        if (!ptrArith) {
          this.error(
            `Operador '${op}' requiere operandos numéricos, se encontró '${typeToString(leftType)}' y '${typeToString(rightType)}'`,
            this.getLine(children[1]), this.getCol(children[1]),
          );
        }
      }
      // Promoción: si hay double, el resultado es double
      if (leftType === 'double' || rightType === 'double') return 'double';
      if (leftType === 'float'  || rightType === 'float')  return 'float';
      return 'int';
    }

    // División por cero literal
    if (op === '/' || op === '%') {
      const rightChild = children[2];
      if (rightChild.name === 'numberLiteral' && (rightChild.image === '0' || rightChild.image === '0.0')) {
        this.error(`División por cero detectada`, this.getLine(children[1]), this.getCol(children[1]));
      }
    }

    return leftType !== 'unknown' ? leftType : rightType;
  }

  private visitUnaryExpr(node: CSTNode): CType {
    const children = node.children ?? [];
    const op = children[0]?.image ?? '';
    const operandType = children[1] ? this.visitNode(children[1]) : 'unknown';
    if (op === '!') return 'bool';
    if (op === '&') return { kind: 'pointer', base: operandType };
    if (op === '*') {
      if (typeof operandType === 'object' && operandType.kind === 'pointer') return operandType.base;
      if (operandType !== 'unknown') {
        this.error(`Operador '*' aplicado a tipo no puntero '${typeToString(operandType)}'`, this.getLine(node), this.getCol(node));
      }
    }
    return operandType;
  }

  private visitPostfix(node: CSTNode): CType {
    const children = node.children ?? [];
    const t = children[0] ? this.visitNode(children[0]) : 'unknown';
    const op = children[1]?.image ?? '';
    if ((op === '++' || op === '--') && !isNumeric(t) && !(typeof t === 'object' && t.kind === 'pointer')) {
      this.error(`Operador '${op}' requiere un tipo numérico o puntero`, this.getLine(node), this.getCol(node));
    }
    return t;
  }

  private visitTernary(node: CSTNode): CType {
    const children = node.children ?? [];
    const condType = children[0] ? this.visitNode(children[0]) : 'unknown';
    if (condType === 'void') {
      this.error(`La condición del operador ternario no puede ser void`, this.getLine(node), this.getCol(node));
    }
    const thenType = children[1] ? this.visitNode(children[1]) : 'unknown';
    const elseType = children[2] ? this.visitNode(children[2]) : 'unknown';
    if (!typesCompatible(thenType, elseType)) {
      this.warn(
        `Los dos ramas del operador ternario tienen tipos incompatibles: '${typeToString(thenType)}' y '${typeToString(elseType)}'`,
        this.getLine(node), this.getCol(node),
      );
    }
    return thenType !== 'unknown' ? thenType : elseType;
  }

  private visitCallExpr(node: CSTNode): CType {
    const children = node.children ?? [];
    const calleeNode = children[0];
    const argListNode = children[1];

    if (!calleeNode) return 'unknown';

    // Obtener nombre de la función
    const funcName = calleeNode.image ?? calleeNode.children?.[0]?.image ?? '';
    const sym = this.table.lookup(funcName);

    if (!sym) {
      this.error(`Función '${funcName}' no declarada`, this.getLine(calleeNode), this.getCol(calleeNode));
      this.visitChildren(argListNode ?? { name: 'argList', children: [] });
      return 'unknown';
    }

    sym.used = true;

    const funcType = sym.type;
    if (typeof funcType === 'string' || funcType.kind !== 'function') {
      this.error(`'${funcName}' no es una función`, this.getLine(calleeNode), this.getCol(calleeNode));
      return 'unknown';
    }

    // Verificar número de argumentos (solo si la función tiene parámetros fijos)
    const argNodes = (argListNode?.children ?? []).filter(c => c.name !== 'op');
    if (funcType.params.length > 0 && argNodes.length !== funcType.params.length) {
      this.warn(
        `Función '${funcName}' espera ${funcType.params.length} argumento(s) pero se pasan ${argNodes.length}`,
        this.getLine(calleeNode), this.getCol(calleeNode),
      );
    }

    // Verificar tipos de argumentos
    for (let i = 0; i < Math.min(argNodes.length, funcType.params.length); i++) {
      const argType = this.visitNode(argNodes[i]);
      if (!typesCompatible(funcType.params[i], argType)) {
        this.warn(
          `Argumento ${i + 1} de '${funcName}': se esperaba '${typeToString(funcType.params[i])}' pero se encontró '${typeToString(argType)}'`,
          this.getLine(argNodes[i]), this.getCol(argNodes[i]),
        );
      }
    }
    // Visitar argumentos extra
    for (let i = funcType.params.length; i < argNodes.length; i++) {
      this.visitNode(argNodes[i]);
    }

    return funcType.returnType;
  }

  private visitArrayAccess(node: CSTNode): CType {
    const children = node.children ?? [];
    const baseType  = children[0] ? this.visitNode(children[0]) : 'unknown';
    const indexType = children[1] ? this.visitNode(children[1]) : 'unknown';

    if (!isNumeric(indexType) && indexType !== 'unknown') {
      this.error(`El índice del arreglo debe ser entero, se encontró '${typeToString(indexType)}'`, this.getLine(node), this.getCol(node));
    }
    if (typeof baseType === 'object' && baseType.kind === 'array')   return baseType.base;
    if (typeof baseType === 'object' && baseType.kind === 'pointer') return baseType.base;
    return 'unknown';
  }

  private visitCast(node: CSTNode): CType {
    const children = node.children ?? [];
    const targetType = this.extractType(children.find(c => c.name === 'typeSpecifier'));
    if (children[1]) this.visitNode(children[1]);
    return targetType;
  }

  private visitIdentifier(node: CSTNode): CType {
    const name = node.image ?? '';
    const sym = this.table.lookup(name);
    if (!sym) {
      this.error(`Variable '${name}' no declarada`, this.getLine(node), this.getCol(node));
      return 'unknown';
    }
    if (!sym.initialized && sym.kind !== 'function') {
      this.warn(`Variable '${name}' usada sin haber sido inicializada`, this.getLine(node), this.getCol(node));
    }
    sym.used = true;
    return sym.type;
  }

  // ── Helpers de tipo ──────────────────────────────────────────────────────────
  private extractType(typeNode: CSTNode | undefined): CType {
    if (!typeNode) return 'unknown';
    const parts = typeNode.children ?? [];
    let base: CType = 'unknown';
    let ptrCount = 0;

    for (const part of parts) {
      if (part.name === 'pointer') { ptrCount++; continue; }
      const v = part.image ?? '';
      if (['int','float','double','char','void','bool','long','short','unsigned','signed'].includes(v)) {
        base = v as CType;
      }
    }

    for (let i = 0; i < ptrCount; i++) {
      base = { kind: 'pointer', base };
    }
    return base;
  }

  private inferNumberType(image: string): CType {
    if (image.includes('.') || image.toLowerCase().includes('e')) {
      return image.endsWith('f') || image.endsWith('F') ? 'float' : 'double';
    }
    if (image.endsWith('l') || image.endsWith('L')) return 'long';
    return 'int';
  }

  // ── Posición del nodo ────────────────────────────────────────────────────────
  private getLine(node: CSTNode): number {
    return (node as any).line ?? (node as any).col ?? 0;
  }

  private getCol(node: CSTNode): number {
    return (node as any).col ?? 0;
  }
}
