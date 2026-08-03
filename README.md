# analyzer-lex

Compilador con etapas de análisis léxico, sintáctico, semántico, generación TAC y optimización.

## Instalación

```bash
pnpm install
```

## API HTTP (NestJS)

```bash
pnpm run start:dev
```

## CLI del compilador

Construir artefactos:

```bash
pnpm run build
```

Ejecutar CLI sobre un archivo fuente:

```bash
pnpm run cli -- ./ruta/archivo.c
```

También se expone binario `analyzer-lex` (campo `bin` en `package.json`) apuntando a `dist/cli.js`.

### Salida y códigos

- Imprime un JSON con todas las etapas del pipeline.
- Código de salida `0`: ejecución correcta sin errores sintácticos.
- Código de salida `2`: ejecución correcta con errores sintácticos.
- Código de salida `1`: error de uso/lectura/ejecución.

## Scripts útiles

- `pnpm run build`: compila proyecto.
- `pnpm run cli -- <archivo>`: ejecuta pipeline completo por CLI.
- `pnpm run test`: corre pruebas unitarias.
- `pnpm run lint`: lint del proyecto.
