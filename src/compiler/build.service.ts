// build.service.ts
// Última fase del compilador: orquesta léxico → sintáctico → semántico →
// código intermedio (TAC) → optimización → generación de código destino →
// ensamblado y enlace, produciendo un ejecutable (.exe) real y autónomo.
//
// El "backend" de este mini-compilador traduce el AST validado a JavaScript
// (reutilizando CTranslator) y lo empaqueta con el mecanismo de Single
// Executable Applications de Node.js: se genera un blob V8 a partir del
// código destino y se inyecta (postject) en una copia del binario de Node,
// produciendo un .exe que corre de forma independiente, sin necesitar Node
// ni ningún compilador C instalado en la máquina destino.

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { inject } from 'postject';

import { lexer } from './lexer';
import { CParser, MooToken } from './c.parser';
import { SemanticAnalyzer } from './semantic';
import { CTranslator } from './translator';
import { TACGenerator, TACProgram } from './ir';
import { Optimizer } from './optimizer';

export type BuildPhase =
  | 'lexico'
  | 'sintactico'
  | 'semantico'
  | 'codigo_intermedio'
  | 'optimizacion'
  | 'generacion_codigo'
  | 'ensamblado_enlace'
  | 'listo';

export type BuildStatus = 'running' | 'ok' | 'warning' | 'error';

export interface BuildEvent {
  phase: BuildPhase;
  status: BuildStatus;
  message: string;
  detail?: unknown;
  buildId?: string;
  fileName?: string;
}

interface BuildRecord {
  filePath: string;
  fileName: string;
  createdAt: number;
}

const SEA_SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const BUILD_TTL_MS = 20 * 60 * 1000; // 20 minutos

@Injectable()
export class BuildService {
  private readonly logger = new Logger(BuildService.name);
  private readonly registry = new Map<string, BuildRecord>();

  /** Ejecuta el pipeline completo, emitiendo un evento por fase. */
  async build(source: string, emit: (event: BuildEvent) => void): Promise<void> {
    await this.cleanupExpiredBuilds();

    // ── 1. Léxico ──────────────────────────────────────────────────────
    emit({ phase: 'lexico', status: 'running', message: 'Escaneando el código fuente…' });
    let rawTokens: MooToken[];
    try {
      lexer.reset(source);
      const tokens = [...lexer];
      rawTokens = tokens.map((t) => ({
        type: t.type ?? 'unknown',
        value: t.value,
        line: t.line ?? 0,
        col: t.col ?? 0,
      }));
      const invalid = tokens.filter((t) => t.type === 'ERROR');
      if (invalid.length > 0) {
        emit({
          phase: 'lexico',
          status: 'error',
          message: `${invalid.length} carácter(es) no reconocido(s) por el lexer`,
          detail: invalid.slice(0, 20).map((t) => ({ value: t.value, line: t.line, col: t.col })),
        });
        this.finishWithError(emit, 'Error léxico: hay caracteres que el analizador no reconoce.');
        return;
      }
      const relevant = tokens.filter((t) => t.type !== 'WS' && t.type !== 'COMMENT');
      emit({
        phase: 'lexico',
        status: 'ok',
        message: `${relevant.length} tokens generados`,
      });
    } catch (err) {
      emit({ phase: 'lexico', status: 'error', message: this.errMsg(err) });
      this.finishWithError(emit, 'La fase léxica falló inesperadamente.');
      return;
    }

    // ── 2. Sintáctico ───────────────────────────────────────────────────
    emit({ phase: 'sintactico', status: 'running', message: 'Construyendo el árbol sintáctico…' });
    const parser = new CParser(rawTokens);
    const cst = parser.parse();
    if (parser.errors.length > 0) {
      emit({
        phase: 'sintactico',
        status: 'error',
        message: `${parser.errors.length} error(es) sintáctico(s)`,
        detail: parser.errors,
      });
      this.finishWithError(emit, 'La compilación se detuvo por errores sintácticos. Corrige el código e inténtalo de nuevo.');
      return;
    }
    emit({
      phase: 'sintactico',
      status: 'ok',
      message: `Árbol sintáctico generado (${cst.children?.length ?? 0} declaración(es) de nivel superior)`,
    });

    // ── 3. Semántico ─────────────────────────────────────────────────────
    emit({ phase: 'semantico', status: 'running', message: 'Verificando tipos y ámbitos…' });
    const semantic = new SemanticAnalyzer().analyze(cst);
    if (semantic.errors.length > 0) {
      emit({
        phase: 'semantico',
        status: 'error',
        message: `${semantic.errors.length} error(es) semántico(s)`,
        detail: semantic.errors,
      });
      this.finishWithError(emit, 'La compilación se detuvo por errores semánticos. Corrige el código e inténtalo de nuevo.');
      return;
    }
    emit({
      phase: 'semantico',
      status: semantic.warnings.length > 0 ? 'warning' : 'ok',
      message:
        semantic.warnings.length > 0
          ? `Sin errores — ${semantic.warnings.length} advertencia(s)`
          : 'Sin errores semánticos',
      detail: semantic.warnings,
    });

    // ── 4. Código intermedio (TAC) ───────────────────────────────────────
    emit({ phase: 'codigo_intermedio', status: 'running', message: 'Generando código de tres direcciones…' });
    let program: TACProgram;
    try {
      program = new TACGenerator().generate(cst);
    } catch (err) {
      emit({ phase: 'codigo_intermedio', status: 'error', message: this.errMsg(err) });
      this.finishWithError(emit, 'La generación de código intermedio falló.');
      return;
    }
    const instrCount =
      program.globals.length + program.functions.reduce((acc, f) => acc + f.code.length, 0);
    emit({
      phase: 'codigo_intermedio',
      status: 'ok',
      message: `${instrCount} instrucciones TAC en ${program.functions.length} función(es)`,
    });

    // ── 5. Optimización ──────────────────────────────────────────────────
    emit({ phase: 'optimizacion', status: 'running', message: 'Aplicando optimizaciones…' });
    const optimizer = new Optimizer();
    let before = 0;
    let after = 0;
    let appliedCount = 0;
    try {
      const globalsResult = optimizer.optimize(program.globals);
      before += globalsResult.stats.instructionsBefore;
      after += globalsResult.stats.instructionsAfter;
      appliedCount += globalsResult.applied.length;

      for (const fn of program.functions) {
        const result = optimizer.optimize(fn.code);
        before += result.stats.instructionsBefore;
        after += result.stats.instructionsAfter;
        appliedCount += result.applied.length;
      }
    } catch (err) {
      emit({ phase: 'optimizacion', status: 'error', message: this.errMsg(err) });
      this.finishWithError(emit, 'La fase de optimización falló.');
      return;
    }
    emit({
      phase: 'optimizacion',
      status: 'ok',
      message: `${appliedCount} optimización(es) aplicada(s) — ${before} → ${after} instrucciones`,
    });

    // ── 6. Generación de código destino ──────────────────────────────────
    emit({ phase: 'generacion_codigo', status: 'running', message: 'Traduciendo a código destino…' });
    const translator = new CTranslator();
    const translated = translator.translate(cst, 'javascript');

    if (!/function\s+main\s*\(/.test(translated.code)) {
      emit({
        phase: 'generacion_codigo',
        status: 'error',
        message: "No se encontró la función 'main' — no hay punto de entrada para el ejecutable",
      });
      this.finishWithError(
        emit,
        "Error de enlazado: undefined reference to 'main'. El programa debe definir 'int main() { ... }'.",
      );
      return;
    }

    // Al hacer doble clic en Windows, la consola se abre y se cierra junto
    // con el proceso — igual que con cualquier .exe de consola compilado con
    // gcc o MSVC. Para que se pueda ver la salida sin abrir una terminal
    // aparte, se agrega una pausa tipo "Presiona ENTER para salir", como
    // hacen Dev-C++/Code::Blocks. Solo se activa si el proceso está
    // realmente conectado a una consola interactiva (stdin y stdout TTY);
    // si la salida se redirige o se ejecuta desde un script, no espera nada.
    const runnableJs =
      translated.code +
      '\n' +
      '(async function __entry() {\n' +
      '  const __code = main();\n' +
      "  if (typeof __code === 'number') process.exitCode = __code;\n" +
      '  if (process.stdout.isTTY && process.stdin.isTTY) {\n' +
      "    process.stdout.write('\\nPresiona ENTER para salir...');\n" +
      '    await new Promise((resolve) => {\n' +
      "      process.stdin.once('data', resolve);\n" +
      '      process.stdin.resume();\n' +
      '    });\n' +
      '  }\n' +
      '})();\n';

    emit({
      phase: 'generacion_codigo',
      status: translated.warnings.length > 0 ? 'warning' : 'ok',
      message:
        translated.warnings.length > 0
          ? `Código destino generado — ${translated.warnings.length} advertencia(s) de compatibilidad`
          : 'Código destino generado',
      detail: translated.warnings,
    });

    // ── 7. Ensamblado y enlace → ejecutable ──────────────────────────────
    emit({ phase: 'ensamblado_enlace', status: 'running', message: 'Empaquetando el ejecutable…' });
    try {
      const buildId = randomUUID();
      const fileName = process.platform === 'win32' ? 'programa.exe' : 'programa';
      const record = await this.packageExecutable(buildId, fileName, runnableJs);
      this.registry.set(buildId, record);
      const size = await this.humanSize(record.filePath);

      emit({
        phase: 'ensamblado_enlace',
        status: 'ok',
        message: `Ejecutable generado (${size})`,
      });

      emit({
        phase: 'listo',
        status: 'ok',
        message: '¡Compilación completa! El ejecutable está listo para descargar.',
        buildId,
        fileName,
      });
    } catch (err) {
      emit({ phase: 'ensamblado_enlace', status: 'error', message: this.errMsg(err) });
      this.finishWithError(emit, 'No se pudo empaquetar el ejecutable en esta máquina.');
      return;
    }
  }

  /** Ubica y valida un build previamente generado para su descarga. */
  getBuild(buildId: string): BuildRecord | undefined {
    return this.registry.get(buildId);
  }

  // ── Empaquetado real: JS → blob SEA → binario inyectado ──────────────
  private async packageExecutable(
    buildId: string,
    fileName: string,
    jsSource: string,
  ): Promise<BuildRecord> {
    const buildDir = path.join(os.tmpdir(), 'analyzer-lex-builds', buildId);
    await fs.mkdir(buildDir, { recursive: true });

    const jsPath = path.join(buildDir, 'program.js');
    const configPath = path.join(buildDir, 'sea-config.json');
    const blobPath = path.join(buildDir, 'program.blob');
    const exePath = path.join(buildDir, fileName);

    await fs.writeFile(jsPath, jsSource, 'utf8');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          main: 'program.js',
          output: 'program.blob',
          disableExperimentalSEAWarning: true,
        },
        null,
        2,
      ),
      'utf8',
    );

    // node --experimental-sea-config sea-config.json  (usa el propio binario
    // que ejecuta este servidor, evitando shims de gestores de versiones)
    await this.run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], buildDir);

    await fs.copyFile(process.execPath, exePath);

    const blob = await fs.readFile(blobPath);
    await inject(exePath, 'NODE_SEA_BLOB', blob, {
      sentinelFuse: SEA_SENTINEL_FUSE,
      overwrite: true,
    });

    return { filePath: exePath, fileName, createdAt: Date.now() };
  }

  private run(command: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd });
      let stderr = '';
      child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `El proceso terminó con código ${code}`));
      });
    });
  }

  private async humanSize(filePath: string): Promise<string> {
    try {
      const stat = await fs.stat(filePath);
      const mb = stat.size / (1024 * 1024);
      return `${mb.toFixed(1)} MB`;
    } catch {
      return '';
    }
  }

  private finishWithError(emit: (event: BuildEvent) => void, message: string) {
    emit({ phase: 'listo', status: 'error', message });
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // ── Limpieza de builds antiguos ───────────────────────────────────────
  private async cleanupExpiredBuilds(): Promise<void> {
    const now = Date.now();
    for (const [id, record] of this.registry) {
      if (now - record.createdAt > BUILD_TTL_MS) {
        this.registry.delete(id);
        await fs.rm(path.dirname(record.filePath), { recursive: true, force: true }).catch((err) => {
          this.logger.warn(`No se pudo limpiar el build ${id}: ${this.errMsg(err)}`);
        });
      }
    }
  }
}
