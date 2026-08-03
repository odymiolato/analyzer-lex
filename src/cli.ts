import { readFile } from 'node:fs/promises';
import { CompilerService } from './src/compiler/compiler.service';

function printUsage(): void {
  console.log('Uso: analyzer-lex <ruta-archivo-c>');
  console.log('Ejemplo: analyzer-lex ./input.c');
}

async function run(): Promise<void> {
  const [, , inputPath] = process.argv;

  if (!inputPath) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  let source: string;
  try {
    source = await readFile(inputPath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`No se pudo leer el archivo "${inputPath}": ${message}`);
    process.exitCode = 1;
    return;
  }

  const compiler = new CompilerService();

  try {
    const tokens = compiler.tokenize(source);
    const parsed = compiler.parse(source);
    const analyzed = compiler.analyze(source);
    const generated = compiler.generateTarget(source);
    const optimized = compiler.optimize(source);

    const result = {
      inputPath,
      stages: {
        lexical: { tokensCount: tokens.length, tokens },
        syntax: { errors: parsed.errors, cst: parsed.cst },
        semantic: analyzed.semantic,
        codegen: generated,
        optimize: optimized,
      },
    };

    console.log(JSON.stringify(result, null, 2));

    if (parsed.errors.length > 0) {
      process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error durante la ejecución del compilador: ${message}`);
    process.exitCode = 1;
  }
}

void run();
