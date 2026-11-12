// Comprobaciones de seguridad de .github/workflows/vigilante.yml (leído como texto).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const YAML = readFileSync(fileURLToPath(new URL('../.github/workflows/vigilante.yml', import.meta.url)), 'utf8');
const lineas = YAML.split('\n');
/** Líneas que no son comentario. */
const activas = lineas.filter((l) => !/^\s*#/.test(l));

const SECRETOS = [
  'MATRICULA',
  'BASTIDOR',
  'LOCALIZADOR',
  'NTFY_TOPIC',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USUARIO',
  'SMTP_PASSWORD',
  'EMAIL_DESTINO',
];

describe('vigilante.yml', () => {
  it('cada secreto se lee con ${{ secrets.NOMBRE }} y nunca tiene un valor en claro', () => {
    for (const nombre of SECRETOS) {
      const definiciones = activas.filter((l) => new RegExp(`^\\s*${nombre}:`).test(l));
      expect(definiciones, nombre).toHaveLength(1);
      expect(definiciones[0]?.trim(), nombre).toBe(`${nombre}: \${{ secrets.${nombre} }}`);
    }
    // No hay otros secretos ni referencias raras.
    const usados = [...YAML.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1]);
    expect(new Set(usados)).toEqual(new Set(SECRETOS));
  });

  it('no contiene valores que parezcan datos reales (correos, tokens, contraseñas)', () => {
    const sinNoreply = YAML.replace(/41898282\+github-actions\[bot\]@users\.noreply\.github\.com/, '');
    expect(sinNoreply).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // correos
    expect(YAML).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/); // tokens de GitHub
    expect(YAML).not.toMatch(/smtp\.[a-z]+\.[a-z]+/i); // host SMTP en claro
    expect(YAML).not.toMatch(/ntfy\.sh\/\w/); // topic en una URL
  });

  it('los valores fijos están en el workflow, no en secretos', () => {
    expect(YAML).toMatch(/^\s+HEADLESS: 'true'$/m);
    expect(YAML).toMatch(/^\s+MODO_SOLO_LECTURA: 'true'$/m);
    expect(YAML).toMatch(/^\s+FECHA_LIMITE: '2026-12-10'$/m);
    expect(YAML).toMatch(/^\s+INTERVALO_MINUTOS: '10'$/m);
  });

  it('solo workflow_dispatch: el schedule está comentado, con su aviso', () => {
    expect(activas.some((l) => /^\s*workflow_dispatch:/.test(l))).toBe(true);
    expect(activas.some((l) => /^\s*schedule:/.test(l))).toBe(false);
    expect(activas.some((l) => /cron:/.test(l))).toBe(false);
    expect(YAML).toMatch(/#\s*activar cuando la ejecución manual sea correcta\n\s*#\s*schedule:/);
  });

  it('permisos y concurrencia', () => {
    expect(YAML).toMatch(/^permissions:\n\s+contents: write/m);
    expect(YAML).toMatch(/^concurrency:\n\s+group: vigilante\n\s+cancel-in-progress: false/m);
  });

  it('no imprime variables ni secretos: sin set -x, echo de variables, printenv ni env', () => {
    for (const l of activas) {
      expect(l, l).not.toMatch(/set -x|set -o xtrace|printenv|^\s*env\s*$|\benv\s*\|/);
      expect(l, l).not.toMatch(/\becho\b.*(\$|\$\{\{)/);
      expect(l, l).not.toMatch(/::add-mask::|::debug::/);
    }
  });

  it('no sube .env ni artefactos (capturas)', () => {
    expect(YAML).not.toMatch(/upload-artifact|screenshot|captura/i);
    // Ninguna referencia al archivo .env (process.env no cuenta).
    expect(YAML).not.toMatch(/(^|[\s'"/])\.env\b/m);
  });

  it('solo empuja a la rama estado, nunca a main', () => {
    const pushes = activas.filter((l) => /git push/.test(l));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatch(/git push --quiet origin HEAD:refs\/heads\/estado /);
    for (const l of activas.filter((x) => /git (push|commit)/.test(x))) expect(l).not.toMatch(/\bmain\b/);
    // El commit se hace dentro de data/ (worktree de la rama estado).
    expect(YAML).toMatch(/working-directory: data\n\s+run: \|\n[\s\S]*git commit --quiet -m "estado: \$\(TZ=Europe\/Madrid date '\+%Y-%m-%d %H:%M'\)"/);
  });

  it('el paso de guardar corre siempre y, si el push falla, el job falla con un mensaje fijo sin valores', () => {
    const guardar = YAML.slice(YAML.indexOf('- name: Guardar data/'));
    expect(guardar).toMatch(/if: always\(\)/);
    // La salida de git (que podría incluir URLs o mensajes del remoto) no se muestra.
    expect(guardar).toMatch(/if ! git push --quiet origin HEAD:refs\/heads\/estado > \/dev\/null 2>&1; then/);
    expect(guardar).toMatch(/echo "::error::No se pudo subir la rama estado\. El ciclo ya se ha ejecutado\."\n\s+exit 1/);
  });

  it('pasos: checkout de main, worktree de estado, Node 22, caché de Playwright, npm ci, ciclo', () => {
    const orden = [
      'uses: actions/checkout@v4',
      'git worktree add',
      'uses: actions/setup-node@v4',
      "packages['node_modules/playwright'].version",
      'uses: actions/cache@v4',
      'run: npm ci',
      'npx playwright install --with-deps chromium',
      'run: npm run ciclo',
      'git push',
    ];
    const posiciones = orden.map((t) => YAML.indexOf(t));
    for (const [i, p] of posiciones.entries()) expect(p, orden[i]).toBeGreaterThan(-1);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
    expect(YAML).toMatch(/ref: main/);
    expect(YAML).toMatch(/node-version: 22/);
    expect(YAML).toMatch(/path: ~\/\.cache\/ms-playwright/);
    expect(YAML).toMatch(/if: steps\.cache-playwright\.outputs\.cache-hit != 'true'\n\s+run: npx playwright install --with-deps chromium/);
  });

  it('los secretos solo se exponen al paso del ciclo', () => {
    const inicioCiclo = YAML.indexOf('- name: Ciclo');
    const finCiclo = YAML.indexOf('- name: Guardar data/');
    for (const m of YAML.matchAll(/secrets\./g)) {
      expect(m.index).toBeGreaterThan(inicioCiclo);
      expect(m.index).toBeLessThan(finCiclo);
    }
  });
});
