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
   avisa al usuario. Si lo detectado es una operación matemática, el aviso dice
   «Operación matemática» (no «Captcha») y solo nombra la pantalla.

   **Excepción — pantalla «cita propuesta»:** esta pantalla muestra siempre una
   operación matemática. En ella el script no detecta, no lee, no escribe ni resuelve la
   operación. Lo único que hace es pulsar una sola vez el enlace «Cambiar fecha y hora»
   (`<a href="#">`, por texto exacto), que lleva al calendario. En esa pantalla nunca se
   pulsan «Aceptar», «Cancelar», «Cambiar estación» ni «Cambiar tipo de inspección», ni se
   cambia el desplegable de hora. En todas las demás pantallas la detección sigue igual:
   si aparece una operación matemática o un captcha, el script se detiene.
5. **Botones por texto exacto.** Los botones y enlaces se localizan por su texto exacto
   (p. ej. `getByRole('button', { name: '...', exact: true })`), nunca por posición
   (`nth`, índices, `first()`/`last()` sobre listas genéricas, coordenadas, etc.).
   **Excepción — flechas de mes del calendario:** no tienen texto, así que se localizan
   por su relación con el título dentro de la fila de cabecera de la tabla del calendario
   (`tr.headrow`):
   - Mes anterior: la celda `td.nav` inmediatamente anterior a `td.title`.
   - Mes siguiente: la celda `td.nav` inmediatamente posterior.

   Nunca se usan índices (`nth`, `first`, `last`) ni coordenadas. Tras cada clic se
   comprueba que `td.title` muestra el mes esperado; si no coincide, el script se detiene.
   Esta excepción solo cubre esas dos celdas.
6. **Sin datos personales en el repositorio.** Matrícula, bastidor, localizador, topic de
   ntfy y cualquier otro dato personal viven solo en `.env` (excluido de git). Nunca en
   el código, los tests, los fixtures, los logs versionados ni las capturas.
7. **Intervalo de 5 minutos** entre comprobaciones (es también el mínimo permitido).
   `config.ts` rechaza valores de `INTERVALO_MINUTOS` menores que 5.

## Avisos

- **Solo huecos NUEVOS.** Un hueco es un día+hora. Un día+hora ya notificado no vuelve a
  avisarse.
- Los huecos notificados se guardan en `data/notificados.json`, con la clave
  `"AAAA-MM-DD HH:MM"` (p. ej. `"2026-11-15 10:15"`). La carpeta `data/` está en
  `.gitignore`. Si el archivo no existe se empieza vacío; si está corrupto se avisa en el
  log, se empieza vacío y no se borra el original (se guarda además una copia
  `notificados.json.corrupto-<fecha>`).
- **Rango:** se avisan huecos de cualquier día desde hoy (incluido) hasta `FECHA_LIMITE`
  (excluida).
- Un único aviso por ciclo con todos los huecos nuevos. Si no hay nuevos, no se envía
  nada. Solo se marcan como notificados si el envío a ntfy ha ido bien.
- **Formato del aviso** (ntfy: título en la cabecera `Title`, mensaje en el cuerpo):
  - Título: `Cita ITV Estepona disponible`
  - Mensaje: `Nueva cita: <día de la semana> <día> de <mes> a las <hora>`
  - Varias horas el mismo día se agrupan: `a las 10:15, 10:30, 11:00`.
  - Varios días: una línea por día.
  - El día de la semana se calcula automáticamente, en español.
- El topic de ntfy nunca se escribe en los logs ni en los mensajes de error.
- **Canales:** ntfy y correo (SMTP con nodemailer: `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USUARIO`, `SMTP_PASSWORD`, `EMAIL_DESTINO`). El correo usa el mismo título como
  asunto y el mismo mensaje como cuerpo. Si llega por al menos un canal, el hueco se marca
  como notificado (el fallo del otro se registra solo con su código, p. ej. `EAUTH`); si
  fallan todos, no se guarda y se reintenta en el siguiente ciclo.
- La contraseña, el usuario SMTP y el destinatario nunca aparecen en logs ni en errores.

## Scripts de prueba manual (fuera de `npm start` y del ciclo real)

- `npm run probar:email` → envía un único correo de prueba; muestra solo "Enviado" o el error.
- `npm run probar:aviso` → ciclo de avisos (ntfy + email) con un hueco inventado
  (2026-11-15 10:15), sin consultar la web de la ITV. Usa `data/notificados-prueba.json`,
  nunca el estado real. La segunda ejecución no envía nada; para repetir la prueba, borrar
  ese archivo.

## Navegación (capa de seguridad en `src/navegador.ts`)

- **Todo clic pasa por `clic(localizador, nombre)`.** Antes de pulsar comprueba que hay
  exactamente un elemento (si hay 0 o más de 1 visibles, se detiene) y que ni su texto,
  ni `value`, ni `aria-label`, ni `title` coinciden con
  `/aceptar|confirmar|enviar|cancelar|cambiar estaci[oó]n|volver/i`; si coinciden, se
  detiene sin pulsar. Ninguna otra parte del código llama a `.click()`
  directamente (un test lo comprueba).
- **Solo se pulsan:**
  - Botones de flujo, por el texto EXACTO de su HTML y `exact: true` (distingue
    mayúsculas; nunca se normaliza ni se busca sin distinguir mayúsculas):
    "Entendido", "SIGUIENTE" (matrícula y bastidor: `<input type="button" value="SIGUIENTE">`),
    "Siguiente" (tipo de inspección y pantalla intermedia tras "Modificar cita":
    `<input type="submit" value="Siguiente">`), "Modificar cita" (datos de la cita:
    `<input type="button" value="Modificar cita">`) (rol `button`), y "Cambiar fecha y
    hora" (cita propuesta: `<a href="#">`, rol `link`). "Volver" no es un botón
    permitido: no se pulsa en ninguna pantalla, igual que "Confirmar anulación".
  - Los números de día dentro de la tabla del calendario que sean `special` o
    `special_sabado` y no sean `disabled` ni `emptycell` (solo con `pulsarDia()`).
  - Las flechas de mes (solo con `cambiarMes()`; ver la excepción de la regla 5).
- **Flujo hasta el calendario (`recorrerFlujo`, grabado con codegen):** Entendido →
  matrícula → tipo de acceso → bastidor → Escape si hace falta → SIGUIENTE → Siguiente →
  verificar "Estación elegida:" → localizador → Modificar cita → Siguiente → Cambiar fecha y hora. Al llegar al
  calendario devuelve el control sin pulsar ningún día; la lectura la hace el ciclo con
  `leerHuecos()` (`pulsarDia()` + `cambiarMes()`). No se añaden ni se repiten clics.
- **Solo se escribe en:** matrícula (`getByRole('textbox', { name: 'Matrícula:', exact: true })`),
  `#bastidor` y `#localizador` (con `rellenarCampo()`), y `select#tipoAcceso` con el valor
  grabado `'2'` (con `elegirTipoAcceso()`). Si alguno no se encuentra, se detiene sin
  inventar otro selector. Antes de "Modificar cita" se comprueba que el localizador no
  está vacío. Los valores de MATRICULA, BASTIDOR y LOCALIZADOR vienen de `config.ts` y
  nunca se registran.
- **Desplegable abierto:** se cierra con `page.keyboard.press('Escape')`, nunca con un
  clic. Es la única tecla que se pulsa.
- **`select#horasCita` nunca se modifica.** Solo se leen sus `<option>` (descartando
  `value="-1"`). Un test comprueba que en `src/` solo hay una llamada a `fill` y una a
  `selectOption` (las de arriba) y ningún otro método que modifique la página.
- **Verificar la estación en la pantalla de datos de la cita**, justo al llegar a ella
  (tras el segundo "Siguiente") y ANTES de rellenar el localizador: la celda con el texto
  exacto "Estación elegida:" debe aparecer una sola vez y la celda siguiente debe ser
  exactamente "ITV ESTEPONA". Si no aparece, está vacía o es otra, se detiene. Es la única
  comprobación de estación: no se busca "Estación:" en la primera pantalla ni en el
  calendario. El error se registra sin datos personales (no se registra el valor leído).
- **Mes:** tras cada cambio de mes se comprueba que `td.title` es el mes esperado; si no,
  se detiene.
- **Captcha, operación matemática ("N + M =") o pantalla inesperada:** se detiene
  (`DetencionError`), se registra el aviso y no se intenta seguir. La operación se
  comprueba antes que el captcha, para que el aviso diga «Operación matemática» y no
  «Captcha». Excepción: en la pantalla «cita propuesta» no se detecta, no se lee, no se
  escribe ni se resuelve la operación; solo se pulsa una vez el enlace «Cambiar fecha y
  hora» (ver regla 4).
- **Aviso en «cita propuesta»:** En la pantalla cita propuesta, si aparece un aviso
  informativo con el botón 'Entendido', el script lo descarta una sola vez antes de pulsar
  el enlace 'Cambiar fecha y hora'. Nunca cierra otros diálogos con Aceptar, Cancelar ni
  Cambiar estación. Si aparece otro diálogo o el enlace no se puede pulsar, se detiene.
- **Ciclo de lectura (`cicloLectura`, en `src/lectura.ts`):** cada ciclo abre un
  navegador nuevo (sin sesión ni cookies del anterior), entra por
  https://www.itvcita.com/, recorre el flujo hasta el calendario, lee los días y sus horas
  y cierra el navegador sin pulsar nada más en la web. No se reutilizan sesiones entre
  ciclos. Los estados de salida son solo dos: `lectura-completa` (con la lista de días,
  que puede estar vacía) y `detenido` (con el motivo).
- **Tests:** usan siempre valores de prueba para matrícula, bastidor y localizador; nunca
  cargan el `.env`.

## Modo exploración (`EXPLORAR_HASTA`)

- `EXPLORAR_HASTA=datos-cita`: el flujo se detiene justo después de
  `verificarEstacionElegida()`, sin rellenar el localizador ni pulsar "Modificar cita".
- `EXPLORAR_HASTA=calendario`: recorre `recorrerFlujo` completo (localizador,
  "Modificar cita", "Siguiente", "Cambiar fecha y hora") y se detiene en la pantalla del
  calendario, sin pulsar ningún día, flecha de mes ni "Aceptar", y sin leer días u horas.
  La verificación de estación antes del localizador se mantiene.
- Cualquier otro valor es un error.
- Solo se registra "Exploración detenida en <punto>. Estación OK" o el error
  correspondiente. Si aparece un control antibots, el error solo nombra la pantalla
  (p. ej. `Operación matemática en la pantalla "cita propuesta".`), nunca la operación,
  el texto de la página, el HTML ni datos del vehículo.
- Se lanza con `scripts/explorar.ts` (`npm run explorar`), que se niega a ejecutarse sin
  `EXPLORAR_HASTA`, no envía avisos, no guarda capturas ni HTML y no forma parte de
  `npm start`. `HEADLESS=false` muestra el navegador y espera a Enter para cerrarlo.

## Modo solo lectura (`MODO_SOLO_LECTURA=true`)

- **Para dejarlo en marcha en la terminal:**
  ```
  MODO_SOLO_LECTURA=true npm run dev
  ```
  Sin `HEADLESS=false`, para que no se abra una ventana en cada ciclo.
- **Bucle:** `npm run dev` / `npm start` ejecutan un `cicloLectura` cada
  `INTERVALO_MINUTOS` (entero, mínimo 5). Sin avisos de huecos ni email: no lee ni escribe
  `data/notificados.json`. Cada ciclo se imprime en la terminal (una línea por mes leído,
  aunque tenga 0 días, y debajo los días con sus horas), sin datos del vehículo.
- **Horario de descanso:** de 23:00 a 07:00 (hora de España) no se ejecutan ciclos.
- **Parada automática:** dos ciclos seguidos en `detenido` paran el bucle con el mensaje
  "Bucle parado: dos ciclos seguidos detenidos (motivo)". Una lectura completa entre
  medias reinicia la cuenta.
- **Aviso de parada:** si el bucle se para por dos ciclos detenidos o por un error no
  controlado, se envía a ntfy un mensaje con título «Vigilante ITV: parado» y el motivo,
  nunca con el topic ni datos del vehículo. Si ntfy falla, se registra el error y el
  proceso termina igualmente. Ctrl+C no envía nada.
- **Ctrl+C:** cierra al momento los navegadores abiertos, no registra el ciclo a medias y
  sale (código 130). Un segundo Ctrl+C sale de inmediato.
- **Un mes sin días no es un error:** el aviso de la web «No hay días seleccionables para
  la estación elegida en el mes seleccionado» (`div.mensaje.error`) no es un diálogo, no
  tapa la flecha y no se usa para decidir el estado: el mes cuenta como 0 días.
- Sin `MODO_SOLO_LECTURA` (o con `false`), `index.ts` no hace nada todavía.

## Registro (`data/lecturas.log`)

- Una línea por ciclo, con la hora de España:
  ```
  AAAA-MM-DD HH:MM:SS  lectura-completa  dias=<n>  [días si hay: 2026-12-11[12:14,12:18] ...]
  AAAA-MM-DD HH:MM:SS  detenido  motivo=<motivo>
  ```
- Sin datos del vehículo, ni topic, ni HTML. `data/` está en `.gitignore`.
- Si no se puede escribir, se registra el error en la terminal y el bucle sigue.

## Latido (ntfy, 09:00 y 20:00)

- A las 09:00 y a las 20:00 (hora de España; una vez por día y hora, dentro de la primera
  media hora) se envía SOLO a ntfy, con el mismo topic, el título «Vigilante ITV: estado»
  y un texto según la última línea de `data/lecturas.log`:
  - lectura-completa sin días: «Sin citas antes del 10 de diciembre. Último ciclo: HH:MM.»
  - lectura-completa con días: «Hay citas disponibles antes del 10 de diciembre. Último ciclo: HH:MM.»
  - detenido: «Lectura detenida (motivo). Último ciclo: HH:MM.»
  - última línea de hace más de 30 minutos (o ninguna): «Sin actividad reciente. Revisa el proceso.»
- La fecha del texto sale de `FECHA_LIMITE`. Nunca se usa el correo. Si ntfy falla, se
  registra el error (sin el topic) y se reintenta dentro de esa media hora.
- Canales: el latido de GitHub Actions (`npm run ciclo`) usa ntfy y email; el del bucle local (`npm run dev`) solo ntfy.

## Estructura

```
src/
  index.ts       → bucle de solo lectura (intervalo, descanso, parada, aviso de parada, Ctrl+C)
  config.ts      → lee las variables de entorno y valida que existan
  navegador.ts   → Playwright: abre la web y llega al calendario
  calendario.ts  → lee los días disponibles y las horas del desplegable
  lectura.ts     → cicloLectura: navegador nuevo → itvcita.com → flujo → lectura → cerrar
  ciclo.ts       → un ciclo sin navegador: filtra huecos nuevos, avisa y los guarda
  estado.ts      → lee y guarda data/notificados.json
  notificar.ts   → formatea el aviso, filtra los nuevos y lo envía a ntfy
  email.ts       → envía el aviso por correo (nodemailer)
  logger.ts      → registra cada comprobación con fecha y resultado
  registro.ts    → una línea por ciclo en data/lecturas.log
  latido.ts      → estado a ntfy a las 09:00 y a las 20:00
  hora.ts        → fecha y hora de España (Europe/Madrid)
scripts/
  probar-email.ts → correo de prueba (manual)
  probar-aviso.ts → ciclo de avisos con un hueco inventado (manual)
tests/
  calendario.test.ts           → pruebas con HTML guardado en tests/fixtures/
  notificar.test.ts            → formato del aviso, filtrado y ciclo (fetch simulado)
  estado.test.ts               → lectura/escritura de notificados.json
  email.test.ts                → correo y ciclo con email (nodemailer simulado)
  navegador.test.ts            → capa de seguridad con un page falso (sin web real)
  lectura.test.ts              → cicloLectura con los fixtures reales (integración)
  index.test.ts                → bucle de solo lectura (reloj y espera simulados)
  registro.test.ts             → formato y escritura de data/lecturas.log
  latido.test.ts               → textos y envío del latido (fetch simulado)
  config.test.ts               → variables de entorno (valores de prueba)
  helpers/paginaFalsa.ts       → page falso: HTML en memoria, registra clics y lecturas
  fixtures/calendario-diciembre.html → HTML de ejemplo (sin datos personales)
  fixtures/calendario-noviembre.html → noviembre sin días, con el aviso de la web
```

## Comandos

- `npm run dev`   → ejecuta con tsx (desarrollo)
- `npm run build` → compila a `dist/`
- `npm start`     → ejecuta la versión compilada
- `npm test`      → ejecuta los tests con Vitest

## Configuración

Copiar `.env.example` a `.env` y rellenar. Variables: `MATRICULA`, `BASTIDOR`,
`LOCALIZADOR`, `NTFY_TOPIC`, `FECHA_LIMITE`, `INTERVALO_MINUTOS` (entero, mínimo 5),
`HEADLESS` (opcional), `MODO_SOLO_LECTURA` (opcional, `true`/`false`) y, para el correo,
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USUARIO`, `SMTP_PASSWORD`, `EMAIL_DESTINO`.
