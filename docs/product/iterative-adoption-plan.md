# Praeco — Plan de adopción iterativa de AI Teammates con HITL

**Estado:** propuesta revisable; autoriza planificación, no ejecución automática de commits, provisión o despliegues.
**Fecha:** 2026-10-18.
**Objetivo:** construir la experiencia financiera de Praeco por incrementos pequeños que funcionen localmente, usando las lecciones de la referencia y cerrando cada incremento con pruebas y revisión humana.
**Entradas:** [handoff PT-001–010](ai-teammates-learning-handoff.md), [auditoría LLM](llm-selection-audit.md), [contrato L3](../architecture/l3-implementation-contract.md), [runtime demo ADR-007](../adr/007-in-process-demo-runtime.md) y [contribución](../CONTRIBUTING.md).

**Dirección actualizada del usuario:** ejecución a cargo de un agente en OpenCode, con esta sesión como revisora. La entrada es el [brief del ejecutor](opencode-execution-brief.md). Primero reproducir y estabilizar el [baseline B0–B6](workspace-baseline.md): login, equipo precargado, chat real e historial y Daytona; después F1–F6 financieros. El baseline define el detalle técnico del primer tramo; este documento define el ciclo HITL y la integración posterior. La interfaz del producto usa identidad exclusiva Praeco.

## 1. Punto de partida comprobado

- Praeco estaba en `main`, HEAD `916777f`, al revisar este plan. Hay documentación local sin commit; preservar y revisar su diff antes de integrarla. Revalidar HEAD y cambios concurrentes al empezar cada bloque.
- La interfaz actual no es una experiencia aceptada por el usuario: la considera inutilizable. El PR #14, `feat(web): add authenticated case intake and evidence workspace`, sigue abierto como draft, sin merge. No es una base obligatoria ni un prerrequisito para este plan. El código HTTP/HTML presente en `apps/finance-dashboard` tampoco determina la tecnología o UX del nuevo workspace.
- El harness ya tiene perfiles, registro de herramientas, runner y adaptadores L1/L2. Evaluar su reutilización por contratos y pruebas, separadamente de la interfaz descartada; su existencia no acredita una experiencia conversacional integrada.
- Existe `packages/financial-store-sql`: prueba una transacción PostgreSQL, y su README declara pendiente conectar el commit del kernel. Inventariarlo antes de planear otra implementación SQL.
- **Línea base ejecutada hoy:** `fnm exec --using=22.23.2 npm run check`. Pasó la fase de build configurada; typecheck falló en `@praeco/financial-store-sql` por no resolver `pg`/sus tipos. Los tests no llegaron a ejecutarse. `pg` y sus tipos están declarados en paquete/lockfile; sincronizar la instalación es la primera comprobación, no un diagnóstico definitivo ni una razón para modificar L1/L2.
- Referencia: commit `de32f461cc9e0ddf4c5087af07c65cf06df7d683` y cambios locales registrados en el handoff. Se probó chat, OpenRouter, archivos y escritorio. App, worker y sandbox de referencia están detenidos, conservando datos.

## 2. Procedencia antes de copiar archivos

La referencia local no contiene archivo de licencia y la API pública de GitHub devolvió `license: null` al consultar el repositorio. No asumir permiso de redistribución por ser público: [explicación de GitHub](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

Antes de trasladar código literal o assets, comprobar licencia aplicable o permiso del titular y guardar su referencia, alcance y atribuciones. Mientras falte esa evidencia, implementar código propio a partir de requisitos y comportamiento observado; usar librerías desde sus fuentes licenciadas. Distinguir las aportaciones propias de esta sesión de los archivos originales o mixtos. No atribuirnos un archivo completo por haberlo modificado.

En B0, revalidar y completar el [inventario de procedencia](reference-baseline-manifest.json) **solo de los archivos elegidos**, con commit base, ruta, hash del archivo local, cambio propio/adaptación y destino. Así quedan incluidos los parches probados, no solo el upstream. Excluir `.env`, caches, credenciales y datos de proveedor. Este inventario no es un volcado del repositorio ni una obligación de copiarlo.

## 3. Composición propuesta para la primera versión

Crear, sujeto a revisión de B0, `apps/finance-workspace` con Next.js/React. Estabilizar primero el frame y recorrido del boilerplate probado con Clerk, metadata conversacional PostgreSQL/Drizzle, transporte Trigger, OpenRouter y Daytona bajo demanda. El [baseline](workspace-baseline.md) fija versiones observadas, rutas y desviaciones acordadas. Después, una composición de servidor invoca los paquetes financieros existentes; conservar el dominio fuera de Next, Clerk, Trigger y Daytona.

- El nuevo workspace será la interfaz principal de Praeco. Reproducir primero el recorrido y lenguaje visual probados, con identidad propia y las diferencias acordadas; validar con el usuario desde el primer incremento visible. Posponer el panel financiero hasta aceptar el baseline. No dedicar una fase a rescatar o pulir la interfaz anterior, ni exigir el merge del PR #14.
- El workspace usa la identidad autenticada del tenant y presenta Vera/Kael/Nova como perfiles de una identidad Praeco. El registro visual no concede permisos.
- El runtime base sigue siendo ADR-007: una composición en proceso de stores, runner y puertos. Reutilizar instancias durante el proceso; no reseedear ledgers en cada request ni crear un runner financiero independiente por conversación.
- No mantener dos interfaces operativas como requisito de la migración. El código anterior puede permanecer temporalmente sin formar parte del recorrido de aceptación; revisar su retirada como un cambio acotado, preservando los contratos y pruebas de dominio que sigan vigentes. El inspector nuevo se construye sobre salidas tipadas de L1/L2, sin depender del HTML anterior.
- Chat y ejecución financiera tienen ciclos distintos. Trigger gestiona la conversación en vivo de B4; no se convierte por ello en propietario del workflow financiero. Cada futura intención financiera se normaliza en el harness y llega a L2 por su puerto protegido.
- LLM y escritorio son adaptadores configurables, cuya prueba en vivo sí es parte del baseline acordado. La demo determinista y CI funcionan sin sus claves. Trigger/Neon conversacionales entran en B3–B4; la persistencia y ejecución financiera entre procesos permanecen en una pista posterior con pruebas propias.

## 4. Ciclo de trabajo y autorización HITL

Para **cada** bloque:

1. Explicar el cambio visible, archivos previstos, contrato que conserva, prueba manual y cualquier recurso/coste que vaya a usar.
2. Implementar solo ese incremento, con respuestas falsas deterministas en las pruebas. Antes de usar servicios externos, dejar configuración y diagnóstico revisables.
3. Ejecutar tests enfocados y `npm run check`; incluir el build del workspace cuando exista. CI permanece offline. Registrar comandos y resultados reales, incluidos fallos y skips.
4. Arrancar localmente y entregar URL, pasos concretos y resultado esperado. El usuario realiza la prueba; registrar captura/traza saneada cuando corresponda. Compilar o recibir HTTP 200 no sustituye esta comprobación.
5. Presentar diff, archivos, resultados, limitaciones y propuesta de commit. El checkpoint puede terminar en **aprobar el incremento y su commit**, **ajustar**, o **pausar**. Una aprobación no habilita automáticamente el siguiente bloque.
6. Tras aprobarse el commit, stagear solo archivos propios de ese incremento. Usar Conventional Commits, rama de feature propuesta `codex/praeco-workspace` y PR para integrar; nunca commit en `main`, ni push/merge/deploy implícitos. Crear la rama cuando se autorice ejecutar el plan, no en esta fase de propuesta.

OpenCode entrega cada bloque con el [formato de revisión](orchestration-review.md). El usuario trae el resultado a esta sesión; se inspecciona diff y evidencia antes de recomendar aceptación. No hay comunicación automática ni autorización para que el ejecutor avance todos los bloques por haber recibido el handoff.

Una unidad puede requerir dos commits si hay dos cambios independientemente verificables. Evitar commits de funciones inconclusas que se anuncien como operativas; no agrupar login, SQL, modelo y escritorio en una entrega gigante. Un ajuste usa un commit posterior; no reescribir historia publicada.

**Este HITL es revisión de desarrollo.** No constituye aprobación financiera. Esa aprobación solo ocurre mediante una acción autenticada de FinanceAdmin, con binding y reevaluación de L2.

## 5. Secuencia de incrementos

Los mensajes siguientes son propuestas de commits; todavía no se han creado. Las rutas de destino son propuestas hasta cerrar B0. **Primer tramo obligatorio:** ejecutar B0–B6 según el [baseline](workspace-baseline.md#6-bloques-de-baseline-y-criterio-de-cierre), sin integrar finanzas antes de su aceptación. B5 incluye Daytona por decisión expresa del usuario.

| Bloque | Entregable y alcance | Commit propuesto | Prueba técnica y checkpoint humano |
| --- | --- | --- | --- |
| B0–B6 · Baseline previo | Inventario, frame fiel, Clerk, perfiles/metadata, chat OpenRouter/Trigger e historial, Daytona y estabilización. Detalle y commits candidatos en el baseline. | Véase B0–B6 | Aceptación del recorrido completo antes de F1. |
| F1 · Documento y evidencia | Subida de una fuente sintética independiente, bytes exactos, ID/caso, invocación L1 y presentación de fuente, incertidumbre y disposición. Reutilizar el adaptador actual; no construir READY en la UI. | `feat(web): ingest synthetic sources through L1` | Tenant, MIME/bytes, hash, estado de review y fuente faltante; tests con L1 real local. HITL: subir PDF sintético y comprobar datos contra el original; probar otro que requiera revisión. No activar cloud/OCR por defecto. |
| F2 · Inspector financiero de lectura | Kael solicita preview L2 por el adaptador actual; UI muestra gates y refs guardadas, con preview explícitamente no vinculante. | `feat(web): render authoritative policy previews` | Preview sin compromisos ni cambios de presupuesto; contexto servidor, grant acotado y validación de referencias. HITL: inspeccionar evidencia, discrepancias y gates; confirmar que pedir explicación no autoriza nada. |
| F3 · Propuesta y decisión simulada | Nova solicita por el harness una decisión L2, con intent/key estables. Antes de exponer el comando, revisar bootstrap de grants demo para que un modelo no cree/amplíe autoridad. | `feat(l3): connect workspace intents to simulated decisions` | Doble envío/retry no duplica compromiso; los fallos duros siguen bloqueados; L2 devuelve el único outcome y presupuesto observado. HITL: ejecutar un caso elegible y otro bloqueado y comparar registros, no solo prosa del bot. |
| F4 · Revisión humana financiera | UI de aprobación/rechazo con identidad FinanceAdmin; estado operativo separado del financiero. Reutilizar lifecycle y observación existentes, completando huecos con tests. | `feat(web): add authenticated financial review actions` | Permiso revocado, expiración, aprobación resuelta antes de instalar espera, doble clic y reevaluación. HITL: caso elegible pendiente, resolverlo con usuario autorizado y comprobar el nuevo registro de L2. La aprobación humana no elimina gates duros. |
| F5 · Expediente y artefactos | Informe determinista desde refs/decisiones reales, historial de herramientas saneado, vista completa y descarga autorizada. | `feat(web): expose evidence-linked case artifacts` | Fuentes inmutables, redacción, permisos por tenant, artefacto faltante y coherencia con L2. HITL: repetir el espíritu del escenario de licencias y abrir fuentes, gates e informe; ninguna cifra o decisión depende de un script financiero improvisado por el modelo. |
| F6 · Cierre financiero | Ocho escenarios sintéticos por L1/harness/L2 y UI; pruebas de inyección, permisos, duplicados y recuperación dentro de los límites ADR-007. | `test(demo): verify governed workspace scenarios` | Golden oracle exclusivamente en tests; ledgers aislados; caso 04 con sus dos fuentes. HITL: revisar al menos automático, bloqueado y aprobación humana; acordar qué parte ya está aceptada y qué queda pendiente. |

El primer bloque de código no empieza hasta tener instalación/check reproducibles en B0. B1–B6 acreditan experiencia e integración técnica; F1–F6 demuestran la operación financiera gobernada. No mezclar ambos criterios de aceptación.

## 6. Infraestructura y checkpoints propios

### A. Daytona y escritorio: B5, antes de integrar finanzas

- El detalle de aceptación está en B5 del baseline. Adaptador de ejecución del lado servidor, staging de archivos sintéticos explícitos, límites y recursos etiquetados por tenant/tarea técnica. Un perfil no crea automáticamente una VM. Cuando exista integración financiera, vincular la tarea a Assignment mediante su contrato.
- Commit separado `feat(web): add optional sandbox desktop inspection`: estado de conexión, vista noVNC, captura y cierre. Una captura no es un registro financiero.
- Antes de crear o arrancar recursos, mostrar alcance y coste esperado; el usuario habilita el adaptador y realiza la prueba. Primero validar credencial sin crear recursos; luego una única tarea de archivos con una VM.
- Probar selección de sandbox, aislamiento, argumentos, plazos, revocación y limpieza. Nunca proporcionar claves financieras/SQL ni capacidad de cambiar cuentas o ledger al sandbox. Registrar fallo de archivo, proceso o captura sin anunciar éxito.
- Revisar la configuración observada de Chromium `--no-sandbox` y el contrato de aislamiento; ocultar su aviso no es una solución. Detener los recursos al finalizar cada sesión; conservar archivos solo según la política acordada.

### B. Persistencia y ejecución financiera entre procesos

La metadata y el transcript conversacionales de B3–B4 no completan esta pista. Tratar el workflow financiero como otra serie de incrementos, no como un cambio de `.env`:

1. Revisar el paquete SQL existente y completar la integración del store financiero bajo propiedad de L2, con tests reales PostgreSQL aislados.
2. Implementar o integrar el `HarnessStore` PostgreSQL de L3 con fencing, idempotencia y outbox. Son datos y transacciones distintos de las tablas financieras.
3. Conectar el driver Trigger.dev como único propietario de ejecución de Assignment, sustituyendo el driver en proceso en esa configuración. Mantener conversación y callbacks fuera de la autoridad financiera.
4. Probar interrupción entre dispatch/commit, resultado desconocido, reanudación, waits y replays con los mismos intent keys. HITL: detener worker, reanudar y comprobar un único compromiso y una decisión real.

Usar proyectos/entornos de desarrollo propios de Praeco y validar el esquema destino antes de escribir. No ejecutar indiscriminadamente el `db:push` de la referencia sobre Praeco. SQL real y Trigger van en pruebas de integración separadas; el check offline no inyecta claves ni aparenta haber ejecutado pruebas que se saltaron. No afirmar durabilidad entre procesos hasta demostrar esta pista.

## 7. Qué trasladar, adaptar o excluir

| Fuente de la referencia | Tratamiento en Praeco |
| --- | --- |
| Sidebar, `chat-header`, avatar, transcript, tool cards y prompt input | Requisitos de UX y componentes elegibles según procedencia. Implementación en el workspace; avatares propios o con licencia verificada. |
| `components/chat.tsx` y acciones de chat | Adaptar transporte y presentación al driver elegido. No copiar acoplamiento obligatorio a sesiones Trigger en la demo ADR-007. |
| `lib/model.ts`, tests propios y configuración OpenRouter | Trasladar las lecciones de API SDK 7, imagen y costes al adaptador servidor; validar con el runtime de Praeco. No copiar el fallback Neon ni tarifas GPT-5 por inercia. |
| `lib/daytona.ts`, `sandbox-tools`, `desktop-panel` | Adaptación opcional de ejecución acotada y escritorio; no una réplica del bot genérico con una VM por personaje. |
| `db/schema.ts`, acciones CRUD de bots, uso y membresías | Diseñar el mapeo a identidades, casos, Assignments y permisos de Praeco. No sustituir su modelo de dominio por tablas de tutorial. |
| `lib/usage.ts` y eventos de consumo | Adoptar medición por proveedor/modelo, límites y conciliación de uso desconocido; presupuestos de inferencia separados de presupuesto financiero y crédito del evento. |
| Clerk Billing, pricing, paywall, `auth-check`, Railway/Sentry de tutorial | Fuera del primer alcance. No trasladar precios, secretos, proyectos, telemetría o pantallas técnicas por copiar carpetas. |
| `MEMORY.md` y recuerdo entre chats | Futuro contexto operativo no confiable, separado por tenant/caso. Nunca registro de cuenta aprobada, política, consentimiento ni resultado financiero. |

## 8. Credenciales y prueba manual por servicio

Las claves se agregan **cuando su bloque las necesita**, no todas al principio. Documentar nombres y requisitos en un `.env.example` sin valores; los valores reales quedan en archivos ignorados del workspace/runner correspondiente. No copiar entero el `.env.local` de la referencia ni leer implícitamente otras aplicaciones.

| Servicio | Momento | Comprobación antes de usarlo |
| --- | --- | --- |
| Ninguno | B1 y demo offline | Arranque, tests y CI sin acceso a proveedores; ausencia de clave opcional deja estado accionable. |
| Clerk Development | B2 | Publishable key pública y secret solo servidor; sesión, vínculo con tenant y roles, logout y acceso denegado. Acordar si se usa una instancia dev dedicada; ninguna dependencia de Billing. |
| PostgreSQL/Neon conversacional | B3 | DB/schema dev dedicado para metadata; no escribir tablas financieras ni asumir que contiene el transcript completo. |
| Trigger Development y OpenRouter | B4 | Proyecto/worker de chat configurados; clave activa local, endpoint acordado y model ID permitido; autenticación de solo lectura antes de inferencia. Ante 401 distinguir qué valor carga cada proceso y compararlo con el panel sin imprimir secretos; no asumir que el éxito histórico de Jev prueba el acceso actual. |
| LlamaCloud | Solo si se elige evaluar extracción hosted | Credenciales explícitas en L1 y orígenes admitidos; consentimiento para subir el documento sintético. El L1 local ya permite avanzar sin activar ese servicio. |
| Daytona | B5 / pista A | Clave servidor; validar primero sin VM, luego recurso identificado y acotado. Bot/perfil guardado no equivale a sandbox listo. |
| PostgreSQL/Neon y Trigger financieros | Pista B | Identificar base/proyecto/entorno, propietario de schemas y workflow financiero; no inferirlos del chat. Clave dev y autorización CLI separadas. No copiar secretos de aprendizaje a producción ni desplegar para resolver una prueba local. |

Al cambiar credenciales, reiniciar los procesos que las consumen y validar que usan la configuración esperada. La copia antigua de Jev permanece con la credencial anterior; cualquier actualización es una acción de configuración separada. No guardar valores, prefijos privados, headers ni prompts completos sensibles en commits, capturas o logs.

**Primer smoke LLM propuesto:** texto sintético pequeño y una herramienta local de solo lectura, máximo tres llamadas, sin retries automáticos, límites de entrada/salida y timeout. Reservar un presupuesto operativo de USD 0,05 y comprobar coste por llamada; no presentar esa cifra como un hard cap del proveedor si la plataforma no lo ofrece. Detenerse ante coste desconocido y conciliar la actividad, incluidos abortos. Los $50 del evento y su reserva para evaluaciones no equivalen al presupuesto financiero de Praeco ni prueban el saldo actual. Registrar modelo, éxito, pasos, tokens, coste y limitaciones saneadas.

## 9. Evidencia y criterio de avance

Mantener una bitácora compacta por bloque en este documento o enlazada al PR:

| Dato | Registro requerido |
| --- | --- |
| Alcance y versión | Bloque, HEAD de Praeco, fuentes/procedencia y diff exacto |
| Pruebas automáticas | Comandos, salida resumida, pass/fail/skipped y motivo |
| Prueba humana | Pasos, resultado visto, captura/traza saneada y fecha |
| Uso externo | Servicio, datos sintéticos enviados, límites, coste reportado y recursos que deben detenerse |
| Decisión | Aprobado para commit, ajustes o pausa; autor de la confirmación humana |
| Cierre | Commit/PR cuando se creen, pendientes y punto exacto para retomar |

Ante una prueba fallida, corregir el incremento actual y repetir su recorrido; no esconderlo con un mock nuevo, quitando auth o relajando un gate. Si cambia una capa, confirmar sus contratos antes de continuar. No avanzar al siguiente bloque porque “compila”.

**Aceptación de la primera integración completa:** tres perfiles disponibles, entrada sintética independiente, evidencia real L1, comando acotado L3, resultado real L2, revisión autenticada cuando corresponda e inspector/artefactos coherentes. Ocho escenarios y pruebas adversariales acreditan una etapa posterior; nada de esto implica pagos reales o preparación para producción.

## 10. Próxima sesión

Entregar a OpenCode el [brief inicial](opencode-execution-brief.md) y encargar solo **B0**: sincronizar instalación desde lockfile, recuperar `npm run check`, cerrar procedencia y confirmar composición/versiones. Excluir la recuperación de la interfaz anterior y el merge del PR #14 de los prerrequisitos. Traer su informe a esta sesión para revisión; después encargar B1 con su URL y prueba manual. Este plan no crea ramas, commits, infraestructura ni claves por sí mismo.
