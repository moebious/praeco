# Praeco — Instrucción de implementación para Droid: base del workspace financiero

**Fecha:** 2026-10-18. **Estado:** propuesta histórica CP1–CP4; su secuencia está reemplazada por el [baseline B0–B6](workspace-baseline.md). No usar sus pasos como encargo activo.
**Orquestador:** el usuario decide y revisa; Droid implementa. El informe de cierre usa el formato de `docs/product/orchestration-review.md`.

**Actualización de retirada (2026-10-18, autorizada por el usuario):** se retira `apps/finance-dashboard` junto con los scripts `web` y `l2:web`. Esto reemplaza la instrucción anterior de conservar esa app intacta y permite actualizar sus referencias de documentación. Se preservan los paquetes financieros, sus pruebas de dominio y demos CLI; no se porta el servidor antiguo ni se conecta finanzas al workspace en este cambio. Temporalmente no hay demo financiera en navegador. `web:workspace` sigue siendo una entrada explícita a una app sin integración financiera; no acredita aceptación ni habilita otros bloques.

**Instrucción vigente de secuencia (2026-10-18):** estabilizar login, equipo precargado, chat real e historial, y Daytona antes de integrar finanzas. Empezar por el [brief del ejecutor](opencode-execution-brief.md) y entregar evidencia con el [protocolo de revisión](orchestration-review.md). La actualización de retirada anterior conserva su alcance independiente. El texto CP1–CP4 que sigue se conserva para trazabilidad; no reemplaza este orden ni los contratos.

## 0. Objetivo de esta entrega

Construir en Praeco, sobre los paquetes financieros **ya implementados y probados**, una base de aplicación que cumpla los cuatro puntos de control:

1. La aplicación abre y permite iniciar sesión.
2. Una factura sintética atraviesa L1 y aparece con su evidencia.
3. L2 produce y persiste una decisión correcta.
4. Los agentes presentan ese resultado y funciona la aprobación humana.

No se construye la plataforma completa. Integrar L1/L2 **tan pronto exista la pantalla básica**, no al final: la primera factura completa debe cruzar la app antes de cualquier función secundaria.

## 1. Qué se conserva del boilerplate de referencia y qué se excluye

Referencia: `/Users/moebious/Work/praeco-references/ai-teammates` (HEAD `de32f46`, parches locales sin commit). **Solo lectura.** Su manifiesto está en `docs/product/reference-baseline-manifest.json`.

**Licencia:** no se encontró licencia en el snapshot ni en upstream. **No copiar archivos ni assets de la referencia.** Se reproduce comportamiento con código propio; componentes primitivos (shadcn/Base UI) se obtienen de sus fuentes licenciadas (CLI/registry), no del checkout ajeno. Iconos Lucide y fuentes Geist: usar versiones licenciadas. Si se usan avatares DiceBear, verificar la licencia del estilo concreto antes de incluirlo.

| Conservar (si el tiempo lo permite tras CP4) | Excluir de esta entrega |
| --- | --- |
| Estructura de app y componentes UI (App Router, sidebar, chat, streaming) | Billing y planes; cualquier paywall |
| Autenticación con Clerk (modo dev) | Medición comercial de tokens y sandbox |
| Conversaciones y mensajes persistidos (metadata propia, no el ledger) | Firecrawl y búsqueda web |
| AI SDK y actividad de herramientas (tool cards) | Daytona, VNC y control de escritorio |
| Panel lateral adaptable al inspector financiero | Memoria compartida entre conversaciones |
| Integración mínima de Trigger.dev (solo transporte de chat, nunca el workflow financiero) | Creación y personalización general de bots |

## 2. Modificaciones de Praeco (obligatorias)

1. **Tres agentes predefinidos: Vera, Kael y Nova.** Sin administrador de bots, sin formulario «New bot». Perfiles estables, versionados, sembrados de forma idempotente.
2. **Inspector financiero** en lugar de escritorio remoto: evidencia con citas, las seis reglas gate-por-gate, presupuesto del periodo y decisión final. Panel lateral navega casos, no conversaciones vacías.
3. **Herramientas conectadas a L1/L2 por puertos protegidos.** El modelo solicita operaciones y explica resultados; **L2 conserva toda la autoridad financiera**. El contexto confiable (`TrustedActorContext` o equivalente) lo inyecta el servidor, jamás el LLM ni el cliente.
4. **Aprobación humana real dentro de la simulación:** una acción autenticada de servidor que llama a la resolución de aprobación de L2, la cual **reevalúa las seis reglas con estado fresco antes de comprometer presupuesto**. Nunca aprueba por encima de un bloqueo duro. Mensajes de chat/emoji/email jamás consumen una aprobación L2.
5. **Conversación grupal acotada:** handoffs (Vera → Kael → Nova) solo después de que el recorrido de una factura funcione de punta a punta. El handoff NO es ejecución durable independiente: el runner financiero sigue siendo el in-process de ADR-007.

Vocabulario de superficie: mostrar siempre el código literal que devuelve L2: **`AUTHORIZED_SIMULATED`**, **`BLOCKED`** o **`PENDING_HUMAN_APPROVAL`**. Se puede añadir una explicación en español junto al código, sin sustituirlo. Nunca `PAID`, `PAGÓ` ni equivalente de pago en ningún idioma ni superficie.

## 3. Ubicación, rama y archivos protegidos

- **Trabajar dentro de Praeco** (`/Users/moebious/Work/praeco`), destino `apps/finance-workspace` (package `@praeco/finance-workspace`; no existe aún). La app anterior (`apps/finance-dashboard`) se conserva intacta, fuera del recorrido de aceptación.
- **Rama separada:** `droid/finance-workspace` (verificar colisiones antes de crearla). **Nunca commits en `main`.** Sin push/merge/deploy sin autorización explícita del usuario.
- **Conventional Commits** (`feat(web): …`, `fix(web): …`); sin trailers de atribución de agentes. Commits pequeños; stagear **solo** archivos propios — el árbol contiene trabajo ajeno sin commit (`README.md` modificado y `docs/product/` sin trackear) que debe preservarse intocado.

**Prohibido modificar:**

- `packages/evidence-intelligence/src/contracts.ts` — contrato L1 congelado; CI rechaza el cambio de hash `ee1f94a797cd461b5fcfa394dd7ebe8cd8d18fd9`.
- Semántica financiera de `packages/financial-decision-kernel` (gates, aprobación, presupuesto) — consumir por su API pública (`preview`, `decideAndCommit`, `resolveApproval`, seeds de escenarios); cualquier cambio de comportamiento requiere ADR.
- `packages/agent-harness`, `packages/external-document-intake`, `packages/financial-store-sql` — igual: consumir, no editar.
- `docs/adr/*`, `AGENTS.md`, `docs/CONTRIBUTING.md`, `.github/workflows/*`.
- El checkout de la referencia (archivos y configuración; quedó detenido a propósito) y sus `.env*` — no abrir, copiar ni imprimir.

**Permitido y esperado:** archivos nuevos bajo `apps/finance-workspace/`, su `package.json`, `.env.example` (solo nombres), scripts raíz **aditivos** (p. ej. `web:workspace`) e integrar su build/typecheck/test en el check raíz sin romper el build previo de paquetes.

## 4. Activos existentes que se reutilizan (no se reconstruyen)

| Necesidad | Fuente (API pública) |
| --- | --- |
| Intake y evidencia L1 | `@praeco/evidence-intelligence`: `createL1()` — `register`, `processWithReceipt`, readers, `summarize` (redacted) |
| Facturas sintéticas demo | `packages/evidence-intelligence/test/fixtures/demo-day/sources/` (entradas sintéticas; generar/copiar como assets propios de la app) |
| Decisión, gates, aprobación | `@praeco/financial-decision-kernel`: `FinancialAuthorizationService` + `scenarios.ts` (seeds aislados por escenario) |
| Harness, agentes, workflow | `@praeco/agent-harness`: `AssignmentService`, `WorkflowRunner` (pasos Vera→Kael→Nova), `InMemoryHarnessStore`, adaptadores L1/L2, `ensureHarnessWorkerGrant` |
| Ejemplo del recorrido 8 escenarios | `packages/financial-decision-kernel/src/cli.ts` (`npm run l2:demo`) como referencia de invocación |

**DEMO-001:** los oráculos (`ground-truth.json`, `original-manifest.json`, resultados esperados) son **solo-test**: nunca importarlos ni exponerlos al runtime ni a los prompts.

## 5. Secuencia de implementación con puntos de control

Integrar temprano: en cuanto exista la pantalla básica (paso 1), conectar la primera factura completa (paso 2). No apilar funcionalidad antes del primer recorrido financiero.

1. **Pantalla base offline (CP-pre):** App Router + Tailwind/shadcn desde fuentes licenciadas, tema claro/oscuro, sidebar, layout. Arranca en **modo demo sin claves** (puerto 3010; usar `localhost` consistente — se observó un bucle de rewrite de Clerk mezclando `127.0.0.1`). Clerk cableado pero pendiente de claves dev del usuario; sin sesión, las acciones de servidor redirigen a login.
2. **CP2 — Factura → L1 → evidencia:** subir un PDF sintético (p. ej. `01.pdf` del demo-day) → `register` + `processWithReceipt` → pantalla de caso con estado L1, sobres y **citas de evidencia** (texto resaltado con referencia a página/línea), importe normalizado USD. Los archivos subidos viven en el store de evidencia L1 (directorios restringidos), nunca en `public/`. Archivo alterado → falla cerrada visible (`REVIEW_REQUIRED`), nunca silenciosa.
3. **CP3 — L2 decide y persiste:** el caso pasa al kernel con los seeds sintéticos del escenario; pantalla del inspector con **las seis reglas gate-por-gate** (verde/rojo con código y razón en español), presupuesto del periodo (límite, comprometido, disponible) y decisión tri-estado. Persistencia in-process (ADR-007): recargar la página conserva los casos; **no reclamar durabilidad entre procesos** en UI ni docs.
4. **CP4 — Agentes presentan + aprobación humana:** el caso corre por el `WorkflowRunner` (Vera inspecciona, Kael explica, Nova somete) con tool cards visibles; caso 03 (MXN 76.000 = USD 3.800 > umbral) queda `PENDING_HUMAN_APPROVAL`; el FinanceAdmin autenticado aprueba desde la UI → **re-evaluación fresca** → `AUTHORIZED_SIMULATED` + presupuesto comprometido, todo visible. Intento de aprobar un caso con bloqueo duro (p. ej. caso 08 cuenta cambiada) → permanece `BLOCKED` con la razón.

Trigger.dev, si sobra tiempo tras CP4: **solo** transporte de chat (patrón B4 del baseline). El workflow financiero permanece in-process. Smokes de modelo vivo: máximo 3 llamadas, presupuesto USD 0,05, claves locales fuera de CI.

## 6. Criterios de aceptación (por punto de control)

**Comunes a todos:** `npm run check` verde en la raíz incluyendo el workspace nuevo (build de paquetes antes de typecheck; nunca typecheck solo en árbol fresco); CI sigue offline (scripted responses, sin claves); sin `PAID`/`PAGÓ` en ninguna superficie (agregar un test de aserción); identidad Praeco (sin branding/enlaces del tutorial); TypeScript strict.

- **CP1:** app abre en `localhost:3010`; con claves dev del usuario: login, logout y acción directa sin sesión → denegada. Sin claves: modo demo explícito, accionable.
- **CP2:** subir `01.pdf` → ID de caso; evidencia con citas legibles sin abrir código; alterar un byte → `REVIEW_REQUIRED` visible; un caso de otro tenant no es accesible por URL/acción.
- **CP3:** cada escenario demo-day produce su decisión esperada (01 autorizado; 03 pendiente; 04/08 frenados con su código de regla); las seis reglas aparecen con razón; presupuesto refleja el compromiso tras autorizar; recargar conserva el caso.
- **CP4:** recorrido Vera→Kael→Nova con tool cards; aprobación autenticada re-evalúa (cambiar el presupuesto durante la espera → `INSUFFICIENT_BUDGET` al aprobar; o `APPROVAL_STALE` si cambia algo estructural); bloqueo duro no apricable por UI ni API; el registro del caso explica el por qué de punta a punta.

**Pruebas automáticas:** vitest en el workspace; cubrir upload→L1 (éxito, alterado, tenant), presentación L2 (seis reglas, tri-estado), aprobación (re-evaluación, single-use, bloqueo duro dominante) y la aserción sin `PAGÓ`. Smokes vivos separados de CI.

## 7. Entregable de cierre

Informe en formato `docs/product/orchestration-review.md`: HEAD/rama, archivos creados, comandos exactos de arranque (URL y puerto), pasos numerados de la prueba local con esperado/observado por punto de control, desviaciones con motivo, riesgos abiertos y commits **propuestos** (no creados sin autorización). El usuario revisa y decide aceptación, push y siguiente bloque.
