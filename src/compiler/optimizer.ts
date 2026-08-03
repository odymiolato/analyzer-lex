// optimizer.ts
// Optimizador de código de tres direcciones (TAC) producido por el
// generador de código destino (ir.ts). Aplica optimizaciones clásicas de
// compiladores hasta alcanzar un punto fijo:
//   1. Plegado de constantes (constant folding)
//   2. Simplificación algebraica (identidades)
//   3. Propagación de copias y constantes (local a cada bloque básico)
//   4. Eliminación de subexpresiones comunes (CSE, local a cada bloque)
//   5. Eliminación de código inalcanzable
//   6. Optimización de saltos (peephole: goto-al-siguiente, saltos encadenados, etiquetas muertas)
//   7. Eliminación de código muerto (temporales nunca usados)

import { Quad, formatQuad } from './ir';

export interface AppliedOptimization {
  pass: string;
  description: string;
}

export interface OptimizerResult {
  code: Quad[];
  applied: AppliedOptimization[];
  stats: {
    instructionsBefore: number;
    instructionsAfter: number;
    removed: number;
  };
}

const PURE_BINARY = new Set([
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
const PURE_UNARY = new Set(['uminus', 'not', 'bnot']);
const JUMP_OPS = new Set(['goto', 'ifFalse', 'ifTrue']);
const NEVER_REMOVE_OPS = new Set([
  'call',
  'param',
  'return',
  'goto',
  'ifFalse',
  'ifTrue',
  'label',
  'func',
  'endfunc',
  '[]=',
  'getparam',
  'decl',
  'storeind',
]);

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
function isNumericLiteral(s: string | null): s is string {
  return s !== null && NUMERIC_RE.test(s);
}
function isTemp(s: string | null): boolean {
  return s !== null && /^t\d+$/.test(s);
}

function evalBinary(op: string, a: string, b: string): string | null {
  const x = parseFloat(a);
  const y = parseFloat(b);
  const bothInt = !a.includes('.') && !b.includes('.');
  let r: number;
  switch (op) {
    case '+':
      r = x + y;
      break;
    case '-':
      r = x - y;
      break;
    case '*':
      r = x * y;
      break;
    case '/':
      if (y === 0) return null;
      r = bothInt ? Math.trunc(x / y) : x / y;
      break;
    case '%':
      if (y === 0) return null;
      r = x % y;
      break;
    case '==':
      return x === y ? '1' : '0';
    case '!=':
      return x !== y ? '1' : '0';
    case '<':
      return x < y ? '1' : '0';
    case '>':
      return x > y ? '1' : '0';
    case '<=':
      return x <= y ? '1' : '0';
    case '>=':
      return x >= y ? '1' : '0';
    case '&':
      r = (x | 0) & (y | 0);
      break;
    case '|':
      r = x | 0 | (y | 0);
      break;
    case '^':
      r = (x | 0) ^ (y | 0);
      break;
    case '<<':
      r = (x | 0) << (y | 0);
      break;
    case '>>':
      r = (x | 0) >> (y | 0);
      break;
    default:
      return null;
  }
  return String(r);
}

function evalUnary(op: string, a: string): string | null {
  const x = parseFloat(a);
  switch (op) {
    case 'uminus':
      return String(-x);
    case 'not':
      return x === 0 ? '1' : '0';
    case 'bnot':
      return String(~(x | 0));
    default:
      return null;
  }
}

/** Índices que son líderes de bloque básico (incluye el 0). */
function computeLeaders(code: Quad[]): Set<number> {
  const leaders = new Set<number>([0]);
  code.forEach((instr, i) => {
    if (instr.op === 'label' || instr.op === 'func') leaders.add(i);
    if (
      JUMP_OPS.has(instr.op) ||
      instr.op === 'return' ||
      instr.op === 'endfunc'
    ) {
      if (i + 1 < code.length) leaders.add(i + 1);
    }
  });
  return leaders;
}

function blockRanges(code: Quad[]): Array<[number, number]> {
  const leaders = Array.from(computeLeaders(code)).sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < leaders.length; i++) {
    const start = leaders[i];
    const end = i + 1 < leaders.length ? leaders[i + 1] : code.length;
    ranges.push([start, end]);
  }
  return ranges;
}

export class Optimizer {
  optimize(input: Quad[]): OptimizerResult {
    let code = input.map((i) => ({ ...i }));
    const applied: AppliedOptimization[] = [];
    const before = code.length;

    const passes: Array<(c: Quad[]) => { code: Quad[]; changed: boolean }> = [
      (c) => this.foldConstants(c, applied),
      (c) => this.simplifyAlgebra(c, applied),
      (c) => this.propagateCopiesAndConstants(c, applied),
      (c) => this.eliminateCommonSubexpressions(c, applied),
      (c) => this.foldConstantBranches(c, applied),
      (c) => this.removeUnreachableCode(c, applied),
      (c) => this.simplifyJumps(c, applied),
      (c) => this.eliminateDeadTemps(c, applied),
    ];

    let iterations = 0;
    let changedAny = true;
    while (changedAny && iterations < 20) {
      changedAny = false;
      for (const pass of passes) {
        const result = pass(code);
        code = result.code;
        if (result.changed) changedAny = true;
      }
      iterations++;
    }

    return {
      code,
      applied,
      stats: {
        instructionsBefore: before,
        instructionsAfter: code.length,
        removed: before - code.length,
      },
    };
  }

  // 1. Plegado de constantes ────────────────────────────────────────────
  private foldConstants(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out = code.map((instr) => {
      if (
        PURE_BINARY.has(instr.op) &&
        isNumericLiteral(instr.arg1) &&
        isNumericLiteral(instr.arg2)
      ) {
        const value = evalBinary(instr.op, instr.arg1, instr.arg2);
        if (value !== null) {
          changed = true;
          applied.push({
            pass: 'Plegado de constantes',
            description: `${formatQuad(instr)}  →  ${instr.result} = ${value}`,
          });
          return q('=', value, null, instr.result);
        }
      }
      if (PURE_UNARY.has(instr.op) && isNumericLiteral(instr.arg1)) {
        const value = evalUnary(instr.op, instr.arg1);
        if (value !== null) {
          changed = true;
          applied.push({
            pass: 'Plegado de constantes',
            description: `${formatQuad(instr)}  →  ${instr.result} = ${value}`,
          });
          return q('=', value, null, instr.result);
        }
      }
      return instr;
    });
    return { code: out, changed };
  }

  // 2. Simplificación algebraica ─────────────────────────────────────────
  private simplifyAlgebra(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out = code.map((instr) => {
      if (
        !PURE_BINARY.has(instr.op) ||
        instr.arg1 === null ||
        instr.arg2 === null
      )
        return instr;
      const { op, arg1, arg2, result } = instr;
      const rewrite = (place: string | null): Quad => {
        changed = true;
        applied.push({
          pass: 'Simplificación algebraica',
          description: `${formatQuad(instr)}  →  ${result} = ${place}`,
        });
        return q('=', place, null, result);
      };
      if (op === '+' && arg2 === '0') return rewrite(arg1);
      if (op === '+' && arg1 === '0') return rewrite(arg2);
      if (op === '-' && arg2 === '0') return rewrite(arg1);
      if (op === '*' && arg2 === '1') return rewrite(arg1);
      if (op === '*' && arg1 === '1') return rewrite(arg2);
      if (op === '/' && arg2 === '1') return rewrite(arg1);
      if (op === '*' && (arg1 === '0' || arg2 === '0')) return rewrite('0');
      return instr;
    });
    return { code: out, changed };
  }

  // 3. Propagación de copias y constantes (local a cada bloque básico) ───
  private propagateCopiesAndConstants(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out = code.slice();

    for (const [start, end] of blockRanges(out)) {
      const env = new Map<string, string>();
      const resolve = (place: string | null): string | null => {
        if (place === null) return null;
        const seen = new Set<string>();
        let cur = place;
        while (env.has(cur) && !seen.has(cur)) {
          seen.add(cur);
          cur = env.get(cur)!;
        }
        return cur;
      };

      for (let i = start; i < end; i++) {
        const instr = out[i];
        if (instr.op === 'label' || instr.op === 'func') continue;

        if (instr.arg1 !== null || instr.arg2 !== null) {
          const newArg1 = resolve(instr.arg1);
          const newArg2 =
            instr.op === 'call' || instr.op === 'param'
              ? instr.arg2
              : resolve(instr.arg2);
          if (newArg1 !== instr.arg1 || newArg2 !== instr.arg2) {
            changed = true;
            applied.push({
              pass: 'Propagación de copias/constantes',
              description: `${formatQuad(instr)}  →  ${formatQuad({ ...instr, arg1: newArg1, arg2: newArg2 })}`,
            });
            out[i] = { ...instr, arg1: newArg1, arg2: newArg2 };
          }
        }

        const updated = out[i];
        if (
          updated.result &&
          !JUMP_OPS.has(updated.op) &&
          updated.op !== 'label' &&
          updated.op !== '[]='
        ) {
          env.delete(updated.result);
          if (updated.op === '=' && updated.arg1 !== null) {
            env.set(updated.result, updated.arg1);
          }
        }
      }
    }

    return { code: out, changed };
  }

  // 4. Eliminación de subexpresiones comunes (local a cada bloque) ──────
  private eliminateCommonSubexpressions(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out = code.slice();

    for (const [start, end] of blockRanges(out)) {
      const available = new Map<string, string>(); // "op|arg1|arg2" -> place que ya tiene el valor

      for (let i = start; i < end; i++) {
        const instr = out[i];
        const isPureBin =
          PURE_BINARY.has(instr.op) &&
          instr.arg1 !== null &&
          instr.arg2 !== null;
        const isPureUn = PURE_UNARY.has(instr.op) && instr.arg1 !== null;

        if (isPureBin || isPureUn) {
          const key = `${instr.op}|${instr.arg1}|${instr.arg2}`;
          const existing = available.get(key);
          if (existing) {
            changed = true;
            applied.push({
              pass: 'Eliminación de subexpresiones comunes',
              description: `${formatQuad(instr)}  →  ${instr.result} = ${existing}`,
            });
            out[i] = q('=', existing, null, instr.result);
          } else if (instr.result) {
            available.set(key, instr.result);
          }
        }

        // Invalidar entradas que dependan de una variable que se acaba de redefinir
        const written = out[i].result;
        if (written && out[i].op !== 'label') {
          for (const [key] of available) {
            const [, a1, a2] = key.split('|');
            if (a1 === written || a2 === written) available.delete(key);
          }
        }
      }
    }

    return { code: out, changed };
  }

  // 4b. Plegado de saltos condicionales con condición constante ──────────
  // ifFalse <literal> goto L  /  ifTrue <literal> goto L  →  goto L (si la
  // condición fuerza el salto) o se elimina (si nunca se toma), habilitando
  // que la eliminación de código inalcanzable pode la rama muerta.
  private foldConstantBranches(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out: Quad[] = [];

    for (const instr of code) {
      if (
        (instr.op === 'ifFalse' || instr.op === 'ifTrue') &&
        isNumericLiteral(instr.arg1)
      ) {
        const isTruthy = parseFloat(instr.arg1) !== 0;
        const alwaysJumps = instr.op === 'ifFalse' ? !isTruthy : isTruthy;
        changed = true;
        if (alwaysJumps) {
          applied.push({
            pass: 'Plegado de saltos constantes',
            description: `${formatQuad(instr)}  →  goto ${instr.result}`,
          });
          out.push(q('goto', null, null, instr.result));
        } else {
          applied.push({
            pass: 'Plegado de saltos constantes',
            description: `Eliminado (nunca salta): ${formatQuad(instr)}`,
          });
        }
        continue;
      }
      out.push(instr);
    }

    return { code: out, changed };
  }

  // 5. Eliminación de código inalcanzable ────────────────────────────────
  private removeUnreachableCode(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    const out: Quad[] = [];
    let changed = false;
    let unreachable = false;

    for (const instr of code) {
      if (
        instr.op === 'label' ||
        instr.op === 'func' ||
        instr.op === 'endfunc'
      ) {
        unreachable = false;
      }
      if (unreachable) {
        changed = true;
        applied.push({
          pass: 'Eliminación de código inalcanzable',
          description: `Eliminado: ${formatQuad(instr)}`,
        });
        continue;
      }
      out.push(instr);
      if (instr.op === 'goto' || instr.op === 'return') unreachable = true;
    }

    return { code: out, changed };
  }

  // 6. Optimización de saltos (peephole) ─────────────────────────────────
  private simplifyJumps(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    let out = code.slice();

    // a) goto al siguiente label inmediato → eliminar
    const withoutRedundantGotos: Quad[] = [];
    for (let i = 0; i < out.length; i++) {
      const instr = out[i];
      const next = out[i + 1];
      if (
        instr.op === 'goto' &&
        next &&
        next.op === 'label' &&
        next.result === instr.result
      ) {
        changed = true;
        applied.push({
          pass: 'Optimización de saltos',
          description: `Eliminado goto redundante al siguiente label: ${formatQuad(instr)}`,
        });
        continue;
      }
      withoutRedundantGotos.push(instr);
    }
    out = withoutRedundantGotos;

    // b) saltos encadenados: goto/ifX L1  donde  L1: goto L2  →  redirigir a L2
    const targetAfterLabel = new Map<string, string>();
    out.forEach((instr, i) => {
      if (instr.op === 'label') {
        const next = out[i + 1];
        if (next && next.op === 'goto' && next.result !== instr.result) {
          targetAfterLabel.set(instr.result!, next.result!);
        }
      }
    });
    if (targetAfterLabel.size > 0) {
      out = out.map((instr) => {
        if (
          JUMP_OPS.has(instr.op) &&
          instr.result &&
          targetAfterLabel.has(instr.result)
        ) {
          const newTarget = targetAfterLabel.get(instr.result)!;
          changed = true;
          applied.push({
            pass: 'Optimización de saltos',
            description: `Salto encadenado redirigido: ${formatQuad(instr)}  →  ${formatQuad({ ...instr, result: newTarget })}`,
          });
          return { ...instr, result: newTarget };
        }
        return instr;
      });
    }

    // c) etiquetas nunca referenciadas → eliminar
    const referenced = new Set<string>();
    for (const instr of out) {
      if (JUMP_OPS.has(instr.op) && instr.result) referenced.add(instr.result);
    }
    const withoutDeadLabels = out.filter((instr) => {
      if (
        instr.op === 'label' &&
        instr.result &&
        !referenced.has(instr.result)
      ) {
        changed = true;
        applied.push({
          pass: 'Optimización de saltos',
          description: `Eliminada etiqueta no referenciada: ${formatQuad(instr)}`,
        });
        return false;
      }
      return true;
    });

    return { code: withoutDeadLabels, changed };
  }

  // 7. Eliminación de código muerto (solo temporales) ────────────────────
  private eliminateDeadTemps(
    code: Quad[],
    applied: AppliedOptimization[],
  ): { code: Quad[]; changed: boolean } {
    let changed = false;
    const out: Quad[] = [];

    for (let i = 0; i < code.length; i++) {
      const instr = code[i];
      if (NEVER_REMOVE_OPS.has(instr.op) || !isTemp(instr.result)) {
        out.push(instr);
        continue;
      }
      const usedLater = code.some(
        (other, j) =>
          j !== i &&
          (other.arg1 === instr.result || other.arg2 === instr.result),
      );
      if (usedLater) {
        out.push(instr);
      } else {
        changed = true;
        applied.push({
          pass: 'Eliminación de código muerto',
          description: `Eliminado (temporal sin uso): ${formatQuad(instr)}`,
        });
      }
    }

    return { code: out, changed };
  }
}

function q(
  op: string,
  arg1: string | null,
  arg2: string | null,
  result: string | null,
): Quad {
  return { op, arg1, arg2, result };
}
