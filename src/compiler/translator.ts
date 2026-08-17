import { CSTNode } from './c.parser';

export type TargetLanguage = 'javascript' | 'cpp';

export interface TranslateResult {
  code: string;
  target: TargetLanguage;
  warnings: string[];
}

export class CTranslator {
  private warnings: string[] = [];
  private indent = 0;
  private target: TargetLanguage = 'javascript';
  private functionMap = new Map<string, CSTNode>();
  private asyncFunctions = new Set<string>();

  translate(cst: CSTNode, target: TargetLanguage): TranslateResult {
    this.warnings = [];
    this.indent = 0;
    this.target = target;
    this.functionMap.clear();
    this.asyncFunctions.clear();

    if (target === 'javascript') {
      this.collectFunctions(cst);
      this.asyncFunctions = this.computeAsyncFunctions();
    }

    const header = target === 'javascript' ? this.jsHeader() : this.cppHeader();
    const body = this.emitNode(cst);

    return {
      code: header + body,
      target,
      warnings: [...this.warnings],
    };
  }

  private jsHeader(): string {
    return `// Traducido automáticamente de C a JavaScript\n\n` +
      `const readline = require('node:readline/promises');\n` +
      `const __rl = readline.createInterface({ input: process.stdin, output: process.stdout });\n` +
      `process.on('exit', () => __rl.close());\n\n` +
      `async function __scanfAssign(specifiers, setters) {\n` +
      `  for (let index = 0; index < setters.length; index++) {\n` +
      `    const raw = await __rl.question('');\n` +
      `    const spec = specifiers[index] ?? '%s';\n` +
      `    let value = raw;\n` +
      `    if (spec === '%d' || spec === '%i' || spec === '%u' || spec === '%x' || spec === '%X') {\n` +
      `      const parsed = Number.parseInt(raw, spec === '%x' || spec === '%X' ? 16 : 10);\n` +
      `      value = Number.isNaN(parsed) ? 0 : parsed;\n` +
      `    } else if (spec === '%f' || spec === '%F' || spec === '%e' || spec === '%E' || spec === '%g' || spec === '%G') {\n` +
      `      const parsed = Number(raw);\n` +
      `      value = Number.isNaN(parsed) ? 0 : parsed;\n` +
      `    } else if (spec === '%c') {\n` +
      `      value = raw.length > 0 ? raw[0] : '';\n` +
      `    }\n` +
      `    setters[index](value);\n` +
      `  }\n` +
      `}\n\n`;
  }

  private cppHeader(): string {
    return `#include <iostream>\nusing namespace std;\n\n`;
  }

  private pad(): string {
    return '  '.repeat(this.indent);
  }

  private emitNode(node: CSTNode): string {
    switch (node.name) {
      case 'program':
        return (node.children ?? []).map((c) => this.emitNode(c)).join('\n');
      case 'functionDefinition':
        return this.emitFunction(node);
      case 'variableDeclaration':
        return this.emitVariableDecl(node);
      case 'block':
        return this.emitBlock(node);
      case 'ifStatement':
        return this.emitIf(node);
      case 'whileStatement':
        return this.emitWhile(node);
      case 'doWhileStatement':
        return this.emitDoWhile(node);
      case 'forStatement':
        return this.emitFor(node);
      case 'returnStatement':
        return this.emitReturn(node);
      case 'breakStatement':
        return `${this.pad()}break;\n`;
      case 'continueStatement':
        return `${this.pad()}continue;\n`;
      case 'expressionStatement':
        return `${this.pad()}${this.emitExpr(node.children![0])};\n`;
      case 'switchStatement':
        return this.emitSwitch(node);
      case 'incompleteDecl':
        return `${this.pad()}// declaración incompleta omitida\n`;
      default:
        if (node.image !== undefined) return node.image;
        return (node.children ?? []).map((c) => this.emitNode(c)).join('');
    }
  }

  private collectFunctions(node: CSTNode): void {
    if (node.name === 'functionDefinition') {
      const name = node.children?.[1]?.image;
      if (name) {
        this.functionMap.set(name, node);
      }
    }

    for (const child of node.children ?? []) {
      this.collectFunctions(child);
    }
  }

  private computeAsyncFunctions(): Set<string> {
    const asyncFunctions = new Set<string>();

    for (const [name, fnNode] of this.functionMap.entries()) {
      if (this.nodeContainsCall(fnNode, 'scanf')) {
        asyncFunctions.add(name);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, fnNode] of this.functionMap.entries()) {
        if (asyncFunctions.has(name)) continue;
        if (this.nodeCallsAsyncFunction(fnNode, asyncFunctions)) {
          asyncFunctions.add(name);
          changed = true;
        }
      }
    }

    return asyncFunctions;
  }

  private nodeContainsCall(node: CSTNode, calleeName: string): boolean {
    if (node.name === 'callExpr') {
      const callee = node.children?.[0];
      if ((callee?.image ?? '') === calleeName) {
        return true;
      }
    }

    return (node.children ?? []).some((child) => this.nodeContainsCall(child, calleeName));
  }

  private nodeCallsAsyncFunction(node: CSTNode, asyncFunctions: Set<string>): boolean {
    if (node.name === 'callExpr') {
      const callee = node.children?.[0];
      const name = callee?.image ?? '';
      if (asyncFunctions.has(name)) {
        return true;
      }
    }

    return (node.children ?? []).some((child) => this.nodeCallsAsyncFunction(child, asyncFunctions));
  }

  private emitType(typeNode: CSTNode): string {
    const parts = (typeNode.children ?? [])
      .map((c) => c.image ?? '')
      .filter(Boolean);
    return parts.join(' ') || 'int';
  }

  private emitFunction(node: CSTNode): string {
    const children = node.children ?? [];
    const typeNode = children[0];
    const name = children[1]?.image ?? 'func';
    const params = children[2];
    const body = children[3];
    const isAsync = this.target === 'javascript' && this.asyncFunctions.has(name);

    if (this.target === 'javascript') {
      const paramStr = this.emitJsParams(params);
      const lines = [`${isAsync ? 'async ' : ''}function ${name}(${paramStr}) {`];
      this.indent++;
      lines.push(this.emitNode(body).trimEnd());
      this.indent--;
      lines.push('}');
      return lines.join('\n') + '\n';
    }

    const retType = this.emitType(typeNode);
    const paramStr = this.emitCppParams(params);
    const lines = [`${retType} ${name}(${paramStr}) {`];
    this.indent++;
    lines.push(this.emitNode(body).trimEnd());
    this.indent--;
    lines.push('}');
    return lines.join('\n') + '\n';
  }

  private emitJsParams(paramList?: CSTNode): string {
    if (!paramList?.children?.length) return '';
    return paramList.children
      .map((p) => {
        const id = p.children?.find((c) => c.name === 'identifier');
        return id?.image ?? '_';
      })
      .join(', ');
  }

  private emitCppParams(paramList?: CSTNode): string {
    if (!paramList?.children?.length) return 'void';
    return paramList.children
      .map((p) => {
        const typeNode = p.children?.[0];
        const id = p.children?.find((c) => c.name === 'identifier');
        const typeStr = typeNode ? this.emitType(typeNode) : 'int';
        return id ? `${typeStr} ${id.image}` : typeStr;
      })
      .join(', ');
  }

  private emitVariableDecl(node: CSTNode): string {
    const children = node.children ?? [];
    const typeNode = children.find((c) => c.name === 'typeSpecifier');
    const ids: { name: string; init?: CSTNode }[] = [];

    for (let i = 0; i < children.length; i++) {
      if (children[i].name === 'identifier') {
        const entry: { name: string; init?: CSTNode } = { name: children[i].image! };
        if (children[i + 1]?.name === 'assign' && children[i + 2]) {
          entry.init = children[i + 2];
          i += 2;
        }
        ids.push(entry);
      }
    }

    if (this.target === 'javascript') {
      return ids
        .map(({ name, init }) => {
          const val = init ? ` = ${this.emitExpr(init)}` : '';
          return `${this.pad()}let ${name}${val};`;
        })
        .join('\n') + '\n';
    }

    const typeStr = typeNode ? this.emitType(typeNode) : 'int';
    return ids
      .map(({ name, init }) => {
        const val = init ? ` = ${this.emitExpr(init)}` : '';
        return `${this.pad()}${typeStr} ${name}${val};`;
      })
      .join('\n') + '\n';
  }

  private emitBlock(node: CSTNode): string {
    const lines = [`${this.pad()}{`];
    this.indent++;
    for (const child of node.children ?? []) {
      lines.push(this.emitNode(child).trimEnd());
    }
    this.indent--;
    lines.push(`${this.pad()}}`);
    return lines.join('\n') + '\n';
  }

  private emitIf(node: CSTNode): string {
    const cond = this.emitExpr(node.children![0]);
    const thenBlock = node.children![1];
    let out = `${this.pad()}if (${cond}) `;
    if (thenBlock.name === 'block') {
      out += '{\n';
      this.indent++;
      for (const c of thenBlock.children ?? []) {
        out += this.emitNode(c);
      }
      this.indent--;
      out += `${this.pad()}}`;
    } else {
      this.indent++;
      out += this.emitNode(thenBlock).trim();
      this.indent--;
    }
    if (node.children!.length > 2) {
      const elsePart = node.children![2];
      out += ' else ';
      if (elsePart.name === 'block' || elsePart.name === 'ifStatement') {
        if (elsePart.name === 'block') {
          out += '{\n';
          this.indent++;
          for (const c of elsePart.children ?? []) {
            out += this.emitNode(c);
          }
          this.indent--;
          out += `${this.pad()}}`;
        } else {
          this.indent++;
          out += this.emitNode(elsePart).trim();
          this.indent--;
        }
      }
    }
    return out + '\n';
  }

  private emitWhile(node: CSTNode): string {
    const cond = this.emitExpr(node.children![0]);
    const body = node.children![1];
    let out = `${this.pad()}while (${cond}) `;
    if (body.name === 'block') {
      out += '{\n';
      this.indent++;
      for (const c of body.children ?? []) {
        out += this.emitNode(c);
      }
      this.indent--;
      out += `${this.pad()}}\n`;
    } else {
      this.indent++;
      out += this.emitNode(body);
      this.indent--;
    }
    return out;
  }

  private emitDoWhile(node: CSTNode): string {
    const body = node.children![0];
    const cond = this.emitExpr(node.children![1]);
    let out = `${this.pad()}do `;
    if (body.name === 'block') {
      out += '{\n';
      this.indent++;
      for (const c of body.children ?? []) {
        out += this.emitNode(c);
      }
      this.indent--;
      out += `${this.pad()}} while (${cond});\n`;
    } else {
      this.indent++;
      out += this.emitNode(body);
      this.indent--;
      out += `${this.pad()}while (${cond});\n`;
    }
    return out;
  }

  private emitFor(node: CSTNode): string {
    const parts = node.children ?? [];
    let init = '';
    let cond = '';
    let update = '';
    let bodyIdx = 0;

    if (parts[0]?.name === 'variableDeclaration') {
      init = this.emitVariableDecl(parts[0]).trim().replace(/;$/, '');
      bodyIdx = 1;
    } else if (parts[0]?.name === 'expressionStatement') {
      init = this.emitExpr(parts[0].children![0]);
      bodyIdx = 1;
    }

    if (parts[bodyIdx] && parts[bodyIdx].name !== 'block') {
      cond = this.emitExpr(parts[bodyIdx]);
      bodyIdx++;
    }
    if (parts[bodyIdx] && parts[bodyIdx].name !== 'block') {
      update = this.emitExpr(parts[bodyIdx]);
      bodyIdx++;
    }

    const body = parts[bodyIdx];
    let out = `${this.pad()}for (${init}; ${cond}; ${update}) `;
    if (body?.name === 'block') {
      out += '{\n';
      this.indent++;
      for (const c of body.children ?? []) {
        out += this.emitNode(c);
      }
      this.indent--;
      out += `${this.pad()}}\n`;
    }
    return out;
  }

  private emitReturn(node: CSTNode): string {
    const expr = node.children?.[0];
    if (!expr) return `${this.pad()}return;\n`;
    return `${this.pad()}return ${this.emitExpr(expr)};\n`;
  }

  private emitSwitch(node: CSTNode): string {
    const expr = this.emitExpr(node.children![0]);
    let out = `${this.pad()}switch (${expr}) {\n`;
    this.indent++;
    for (let i = 1; i < (node.children?.length ?? 0); i++) {
      const clause = node.children![i];
      if (clause.name === 'caseClause') {
        out += `${this.pad()}case ${this.emitExpr(clause.children![0])}:\n`;
        this.indent++;
        for (let j = 1; j < clause.children!.length; j++) {
          out += this.emitNode(clause.children![j]);
        }
        this.indent--;
      } else if (clause.name === 'defaultClause') {
        out += `${this.pad()}default:\n`;
        this.indent++;
        for (const c of clause.children ?? []) {
          out += this.emitNode(c);
        }
        this.indent--;
      }
    }
    this.indent--;
    out += `${this.pad()}}\n`;
    return out;
  }

  private emitExpr(node: CSTNode): string {
    switch (node.name) {
      case 'numberLiteral':
      case 'stringLiteral':
      case 'charLiteral':
      case 'booleanLiteral':
      case 'identifier':
        return node.image ?? '';
      case 'assignment':
      case 'binaryExpr':
      case 'ternaryExpr':
        return (node.children ?? [])
          .map((c) => (c.name === 'op' ? ` ${c.image} ` : this.emitExpr(c)))
          .join('');
      case 'unaryExpr': {
        const op = node.children![0].image ?? '';
        const operand = this.emitExpr(node.children![1]);
        return op.length > 1 ? `${op}${operand}` : `${op}${operand}`;
      }
      case 'postfixExpr':
        return `${this.emitExpr(node.children![0])}${node.children![1].image ?? ''}`;
      case 'callExpr':
        return this.emitCall(node);
      case 'arrayAccess':
        return `${this.emitExpr(node.children![0])}[${this.emitExpr(node.children![1])}]`;
      case 'memberAccess':
        return `${this.emitExpr(node.children![0])}${node.children![1].image ?? '.'}${node.children![2].image ?? ''}`;
      case 'castExpr':
        if (this.target === 'javascript') {
          this.warnings.push(`Cast omitido en JS: (${this.emitType(node.children![0])})`);
          return this.emitExpr(node.children![1]);
        }
        return `(${this.emitType(node.children![0])})${this.emitExpr(node.children![1])}`;
      case 'sizeofExpr':
        if (this.target === 'javascript') {
          this.warnings.push('sizeof no soportado en JS — reemplazado por 0');
          return '0';
        }
        return `sizeof(${node.children![0].name === 'typeSpecifier' ? this.emitType(node.children![0]) : this.emitExpr(node.children![0])})`;
      case 'groupedExpr':
        return `(${this.emitExpr(node.children![0])})`;
      case 'argList':
        return (node.children ?? []).map((c) => this.emitExpr(c)).join(', ');
      default:
        return (node.children ?? []).map((c) => this.emitExpr(c)).join('');
    }
  }

  private emitCall(node: CSTNode): string {
    const callee = node.children![0];
    const args = node.children![1];
    const fnName = callee.image ?? this.emitExpr(callee);

    if (fnName === 'printf') {
      return this.translatePrintf(args);
    }
    if (fnName === 'scanf') {
      return this.target === 'javascript'
        ? this.translateScanf(args)
        : `/* cin >> ... */`;
    }

    if (this.target === 'javascript' && this.asyncFunctions.has(fnName)) {
      return `await ${fnName}(${args ? this.emitExpr(args) : ''})`;
    }

    return `${fnName}(${args ? this.emitExpr(args) : ''})`;
  }

  private translateScanf(argsNode?: CSTNode): string {
    const args = argsNode?.children ?? [];
    if (args.length === 0) {
      return 'await __scanfAssign([], [])';
    }

    const formatArg = args[0];
    const specifiers = this.extractScanSpecifiers(formatArg?.image ?? '');
    const setters = args.slice(1).map((arg, index) => {
      const target = this.unwrapAddressOf(arg);
      const targetExpr = this.emitLValue(target);
      const specifier = specifiers[index] ?? '%s';
      const castExpr = this.scanCastExpr('value', specifier);
      return `(value) => { ${targetExpr} = ${castExpr}; }`;
    });

    return `await __scanfAssign(${JSON.stringify(specifiers.slice(0, setters.length))}, [${setters.join(', ')}])`;
  }

  private unwrapAddressOf(node: CSTNode): CSTNode {
    if (node.name === 'unaryExpr' && node.children?.[0]?.image === '&' && node.children?.[1]) {
      return node.children[1];
    }
    return node;
  }

  private emitLValue(node: CSTNode): string {
    switch (node.name) {
      case 'identifier':
        return node.image ?? '';
      case 'arrayAccess':
        return `${this.emitExpr(node.children![0])}[${this.emitExpr(node.children![1])}]`;
      case 'memberAccess':
        return `${this.emitExpr(node.children![0])}${node.children![1].image ?? '.'}${node.children![2].image ?? ''}`;
      case 'groupedExpr':
        return this.emitLValue(node.children?.[0] ?? node);
      default:
        return this.emitExpr(node);
    }
  }

  private extractScanSpecifiers(formatRaw: string): string[] {
    const format = this.decodeStringLiteral(formatRaw);
    return format.match(/%[diufFeEgGxXsc]/g) ?? [];
  }

  private decodeStringLiteral(raw: string): string {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.replace(/^"|"$/g, '');
    }
  }

  private scanCastExpr(valueExpr: string, specifier: string): string {
    switch (specifier) {
      case '%d':
      case '%i':
      case '%u':
        return `Number.isNaN(Number.parseInt(${valueExpr}, 10)) ? 0 : Number.parseInt(${valueExpr}, 10)`;
      case '%x':
      case '%X':
        return `Number.isNaN(Number.parseInt(${valueExpr}, 16)) ? 0 : Number.parseInt(${valueExpr}, 16)`;
      case '%f':
      case '%F':
      case '%e':
      case '%E':
      case '%g':
      case '%G':
        return `Number.isNaN(Number(${valueExpr})) ? 0 : Number(${valueExpr})`;
      case '%c':
        return `${valueExpr}.length > 0 ? ${valueExpr}[0] : ''`;
      default:
        return valueExpr;
    }
  }

  private translatePrintf(argsNode: CSTNode): string {
    const args = argsNode.children ?? [];
    if (args.length === 0) {
      return this.target === 'javascript' ? 'console.log()' : 'cout << endl';
    }

    const formatArg = args[0];
    const formatStr = formatArg.image ?? '';

    if (this.target === 'javascript') {
      const placeholders = args.slice(1);
      if (placeholders.length === 0) {
        const plain = formatStr.replace(/^"|"$/g, '').replace(/\\n/g, '\\n');
        return `console.log("${plain}")`;
      }
      const templateParts: string[] = [];
      let fmt = formatStr.replace(/^"|"$/g, '');
      let argIdx = 0;
      fmt = fmt.replace(/%[dfsc]/g, () => {
        templateParts.push(`\${${this.emitExpr(placeholders[argIdx++])}}`);
        return '';
      });
      if (argIdx === 0) {
        return `console.log(${this.emitExpr(formatArg)}, ${placeholders.map((a) => this.emitExpr(a)).join(', ')})`;
      }
      return `console.log(\`${fmt}${templateParts.join('')}\`)`;
    }

    const rest = args.slice(1).map((a) => this.emitExpr(a)).join(' << " " << ');
    const fmt = formatStr.replace(/^"|"$/g, '').replace(/\\n/g, '" << endl << "');
    return rest ? `cout << "${fmt}" << " " << ${rest} << endl` : `cout << "${fmt}" << endl`;
  }
}
