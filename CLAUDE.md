# CLAUDE.md — Vigilante de citas ITV Estepona

Proyecto Node.js + TypeScript que vigila la disponibilidad de citas en la web de cita
previa de Veiasa (https://www.itvcita.com/) para la estación **ITV ESTEPONA** y avisa
(vía ntfy) cuando aparece un día anterior a `FECHA_LIMITE` (por defecto 2026-12-10).

## Reglas obligatorias (respetar SIEMPRE)

1. **Solo ITV ESTEPONA.** Únicamente se consulta la estación "ITV ESTEPONA". Nunca otra
   estación. Si la estación seleccionada no es exactamente esa, el script se detiene.
2. **Solo lectura.** El script **nunca** pulsa "Aceptar", "Confirmar" ni
   "Confirmar anulación". Cambiar la cita lo hace siempre el usuario a mano.
3. **"Modificar cita" sin guardar.** Al entrar en "Modificar cita" no se confirma nada;
   siempre se sale sin guardar.
4. **Sin saltarse controles antibots.** No se resuelven captchas, operaciones
   matemáticas ni ningún otro control antibots. Si aparecen, el script se detiene y
   avisa al usuario.
5. **Botones por texto exacto.** Los botones y enlaces se localizan por su texto exacto
   (p. ej. `getByRole('button', { name: '...', exact: true })`), nunca por posición
   (`nth`, índices, `first()`/`last()` sobre listas genéricas, coordenadas, etc.).
6. **Sin datos personales en el repositorio.** Matrícula, bastidor, localizador, topic de
   ntfy y cualquier otro dato personal viven solo en `.env` (excluido de git). Nunca en
   el código, los tests, los fixtures, los logs versionados ni las capturas.
7. **Intervalo mínimo de 5 minutos** entre comprobaciones. `config.ts` rechaza valores
   de `INTERVALO_MINUTOS` menores que 5.

## Estructura

```
src/
  index.ts       → bucle principal con el intervalo
  config.ts      → lee las variables de entorno y valida que existan
  navegador.ts   → Playwright: abre la web y llega al calendario
  calendario.ts  → lee los días disponibles y las horas del desplegable
  notificar.ts   → envía el aviso a ntfy
  logger.ts      → registra cada comprobación con fecha y resultado
tests/
  calendario.test.ts           → pruebas con HTML guardado en tests/fixtures/
  fixtures/calendario-diciembre.html → HTML de ejemplo (sin datos personales)
```

## Comandos

- `npm run dev`   → ejecuta con tsx (desarrollo)
- `npm run build` → compila a `dist/`
- `npm start`     → ejecuta la versión compilada
- `npm test`      → ejecuta los tests con Vitest

## Configuración

Copiar `.env.example` a `.env` y rellenar. Variables: `MATRICULA`, `BASTIDOR`,
`LOCALIZADOR`, `NTFY_TOPIC`, `FECHA_LIMITE`, `INTERVALO_MINUTOS`, `HEADLESS` (opcional).
