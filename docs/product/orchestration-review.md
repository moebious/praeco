# Praeco — Entrega de OpenCode y revisión en esta sesión

## Responsabilidad y canal

OpenCode implementa el bloque autorizado y produce evidencia; esta sesión inspecciona el resultado y recomienda aceptar, ajustar o pausar. El usuario mueve el informe entre herramientas y decide. No hay agente conectado automáticamente, monitor periódico ni acceso implícito a la conversación de OpenCode.

Si ambos trabajan en el mismo checkout, revisar archivos reales y evitar ediciones simultáneas de implementación durante la revisión. Si OpenCode trabaja en otro checkout/máquina, aportar commit/rama o diff y salidas saneadas; un resumen sin diff no permite verificar implementación. Estos informes nunca incluyen `.env`, headers, URLs firmadas, tokens ni datos reales.

## Formato que entrega el ejecutor al cerrar cada bloque

Copiar y completar; usar `NO EJECUTADO`/`PENDIENTE` cuando corresponda. No redactar un resultado esperado como si se hubiera observado.

```text
BLOQUE: B0 | B1 | ... | F1
OBJETIVO AUTORIZADO:
CHECKOUT / RAMA / HEAD INICIAL / HEAD FINAL:
CAMBIOS LOCALES PREEXISTENTES PRESERVADOS:
ESTADO: implementado, pendiente de revisión | necesita ajuste | bloqueo externo

1. Cambio visible y alcance
   - Qué funciona ahora; qué no se implementó en este bloque.
   - Archivos cambiados y por qué; diff o commit exacto si existe.
   - Commits: creados/autorizados o solo propuestos; no confundirlos.

2. Fidelidad y procedencia
   - Archivo/patrón del manifiesto consultado, hash/diferencias detectadas.
   - Copiado con licencia/permiso documentado | adaptado | implementación propia.
   - Desviaciones del baseline: motivo, efecto y prueba.

3. Pruebas automáticas (comando / entorno / exit code / resumen)
   - Instalación y Node/npm efectivos cuando cambien.
   - npm run check; build/lint del workspace y tests enfocados.
   - Fallos previos vs nuevos; pruebas omitidas y razón.
   - CI offline separado de los smokes en vivo.

4. Prueba local
   - Comandos reales de arranque, procesos/puerto y URL.
   - Pasos numerados, datos sintéticos, esperado y observado.
   - Capturas/trazas saneadas y dónde están.
   - Verificación del usuario: PENDIENTE o resultado con fecha.

5. Servicios y estado
   - Nombres de variables requeridas y configuradas; nunca valores.
   - Modelo/proveedor efectivo, llamadas/steps, coste conocido/desconocido.
   - Recursos creados/arrancados/detenidos y evidencia de cleanup.
   - Persistencia comprobada: reload | restart web | restart worker.

6. Límites y siguiente acción
   - Riesgos/defectos abiertos con reproducción.
   - Contratos preservados y cualquier ADR requerido.
   - Mensaje Conventional Commit propuesto y archivos a stagear.
   - Próximo bloque propuesto, sin empezarlo.
```

## Qué revisa el orquestador

1. **Alcance:** coincide con B0–B6 del [baseline](workspace-baseline.md) o F1–F6 del [plan](iterative-adoption-plan.md); ninguna función posterior se presenta como completada por tener un placeholder.
2. **Fidelidad:** cambios mínimos respecto del recorrido acordado, organización del boilerplate y stack fijado. Desviaciones justificadas, ninguna vuelta a la UI rechazada.
3. **Diff:** inspección real de archivos; imports servidor/cliente, versión/lockfile, scripts raíz, aislamiento de datos, errores y consumo. En B0 revisar comandos/reportes antes de aprobar el alcance de B1.
4. **Evidencia:** ejecutar checks reproducibles cuando el checkout esté disponible; contrastar logs y UI. La falta de evidencia es pendiente, no éxito. Los tests verdes no sustituyen la prueba humana.
5. **Autoridad:** auth/tenant/ownership verificados en servidor; L1/L2/L3 y ledger separados de conversación/Daytona. Revisión de desarrollo y aprobación financiera son cosas distintas.
6. **Entrega:** identidad Praeco, procedencia conservada fuera del producto, sin secretos ni cambios ajenos, commit pequeño y correcto. Sin push/merge/deploy implícitos.

## Resultado de revisión

Entregar una de estas decisiones con evidencia y alcance:

- **Listo para aceptación humana:** checks y diff revisados; faltan pasos concretos de UI que solo el usuario haya acordado realizar.
- **Aceptado por el usuario:** registrar su confirmación, bloque y pruebas; un commit requiere autorización aplicable. El siguiente bloque se encarga explícitamente.
- **Requiere ajustes:** findings priorizados, archivo/línea cuando aplique, reproducción y criterio de resolución. Enviar un encargo de corrección enfocado a OpenCode.
- **Bloqueo externo:** dato, credencial o acción humana que falta; resto del trabajo revisable completado. Sin compartir secretos ni eludir controles.

No emitir «aprobado» cuando solo se revisó un informe narrativo. Señalar qué se inspeccionó directamente, qué reportó OpenCode y qué confirmó el usuario.

## Bitácora mínima

La evidencia B2 está en [revisión de autenticación](evidence/b2/auth-review.md). Distingue las pruebas offline ya ejecutadas de la comprobación real de login/logout todavía pendiente; un test con el SDK simulado no se registra como una sesión real.

| Bloque / HEAD o diff | Verificación técnica | Prueba humana | Decisión y commit | Pendiente |
| --- | --- | --- | --- | --- |
| Preparación del handoff | Documentación y enlaces; sin ejecución de baseline | Orden B0–B6 acordado el 2026-10-18 | Sin commits creados | Primera entrega B0 de OpenCode |
| B0 · `74759c7` rama `feat/web-finance-workspace` | **Base prístina**: `npm ci` exit 0 (0 vulnerabilidades); `npm run check` exit 0: build 5 paquetes, typecheck 7/7, **265 passed / 5 skipped (SQL)**. Fallo histórico de `pg` **no reproducido**. Node 22.23.2 / npm 10.9.8. Procedencia: 0 copias literales (referencia sin licencia); manifiesto 37 entradas en *inspect only*. Desviaciones candidatas documentadas para el bloque de la app: `next` 16.4.2 (corrige RCE crítico GHSA-vcvr-r3jv-pc5j) y `typescript` 7.0.2 (alinea al toolchain del monorepo). | **NO EJECUTADO**: sin arranque de UI ni puerto (B0 es docs/config). Verificación del usuario **PENDIENTE** | **Sin commits ni staging; B0 sin cambios de código**: `package-lock.json` revertido a `HEAD` y scaffold WIP archivado fuera del repo en `~/Work/praeco-wip-archive/finance-workspace-2026-10-18` (íntegro, recuperable). Preservados `README.md` (mod) y `docs/product/` | Aprobación humana de B0; después encargar B1 |
| B1 · `74759c7` rama `feat/web-finance-workspace` (sin commits) | **Implementado**: `apps/finance-workspace` (`@praeco/finance-workspace`) con Next 16.4.2 / React 19.2.8 / Tailwind 4.3.3, preset `base-nova` + Base UI **desde el registro licenciado**; frame (sidebar colapsable a iconos con estado recordado, header h-12, transcripción `max-w-3xl` con scroll propio, compositor multilínea), tema claro/oscuro, radio `0.625rem`, tipografía Geist **local** (el build no descarga fuentes), identidad Praeco (`app/icon.svg` propio; sin logo/favicon ni branding del template), arranque directo al trabajo, control de escritorio que informa *no configurado*. Sin claves ni proveedores en el import. `npm run check` exit 0: build **6 workspaces** (incluye la app), typecheck 8/8, lint, **274 passed / 5 skipped**. Workspace: build/lint/typecheck + **9 tests** propios. Puerto **3010**; el dashboard legado y los scripts `web` / `l2:web` fueron retirados y `web:workspace` sigue siendo la entrada explícita. Desviaciones: Tailwind vía `@tailwindcss/turbopack` (integración que trae la plantilla 16.4.2, en lugar de PostCSS manual); `instant = false` documentado en el layout del workspace y en la ruta de chat (opt-out de Cache Components de Next 16 para páginas dinámicas). Lockfile: **1 entrada cambiada** (`typescript` raíz 7.0.2→6.0.3, exigido por el peer `>=4.8.4 <6.1.0` de `@typescript-eslint`; cada workspace conserva 7.0.2), 0 eliminadas. Advisory: **8 altas, todas con raíz única en `braces 3.0.3`** (última versión publicada, sin corrección disponible), alcanzadas solo por tooling de desarrollo (`eslint-config-next`, `shadcn`); nada entra al bundle. Bug real corregido: pulsar *Detener* sustituía el botón bajo el cursor y el `mouseup` reenviaba el borrador (2 envíos); ahora 1 envío, compositor sin recargar y **reintento explícito** en la tarjeta detenida. | Usuario confirmó **B1 aprobado** tras revisar la evidencia visual en esta conversación (2026-10-18). Tests enfocados posteriores: **90/90** workspace. | **Aceptado por el usuario; sin commit creado ni autorizado**. Esta aceptación no cubre B2 ni bloques posteriores. | B2: completar el checkpoint real de Clerk; después revisar B3 por separado |
| B2 · revisión local sobre `74759c7` | Implementación de acceso inspeccionada; en la auditoría previa el workspace pasó 49 tests offline. Matriz y límites en [evidencia B2](evidence/b2/auth-review.md); build/tipos/lint pasaron, check global previo con timeout DocJev fuera del workspace | Login/logout reales con Clerk **PENDIENTES**; tests de SDK simulado no equivalen a prueba humana | Implementado y revisado offline; **sin aceptación humana ni commits** | Completar checkpoint real y registrar su resultado antes de aceptar B2 |
| Correcciones de auditoría · `74759c7` (sin commits) | Check completo **exit 0**, build/tipos/lint y **348 passed / 5 skipped (SQL)**; workspace 90 tests. Regresiones de navegación 2 fallos antes, 10 passes después; UI de producción comprobada en desktop y 390×844. [Informe](evidence/2026-10-18-local-fixes.md) | Login/logout reales de B2 **PENDIENTES**; no se inventa aceptación humana | Hallazgos corregidos; trabajo concurrente preservado; sin staging ni commits | Revisar B3 por separado; ejecutar checkpoint real B2 |
