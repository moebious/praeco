# Praeco — Entrada para el agente ejecutor de OpenCode

**Fecha:** 2026-10-18. **Estado:** instrucciones de entrega; implementación todavía no iniciada.

## Encargo y responsabilidades

Construye el workspace principal de Praeco mediante incrementos probados. El usuario ejecutará el trabajo con OpenCode; esta sesión de Codex revisará alcance, diffs y evidencia que el usuario traiga. No hay comunicación automática entre herramientas. El usuario conserva la decisión final sobre aceptación y commits.

La prioridad acordada es **baseline fiel y estable primero**: login, Vera/Kael/Nova precargados, chat real, historial y prueba Daytona; después integrar finanzas. Reproducir la estructura y el recorrido del boilerplate probado hasta ese punto. Posponer rediseños, frameworks alternativos y funciones adicionales. La UI existente de Praeco fue descartada por inutilizable; el PR #14 no es una dependencia.

## Arranque obligatorio

1. Trabaja en `/Users/moebious/Work/praeco`. Lee `AGENTS.md`, [contribución](../CONTRIBUTING.md) y este documento. Comprueba rama, HEAD y cambios locales. Hay documentos de esta sesión sin commit: identifícalos y preserva el trabajo ajeno.
2. Lee el [baseline técnico y sus bloques B0–B6](workspace-baseline.md). Es la fuente de verdad del primer tramo. Consulta el [handoff PT-001–010](ai-teammates-learning-handoff.md) para el porqué de las adaptaciones y el [plan de integración](iterative-adoption-plan.md) para la etapa financiera posterior.
3. Lee [ADR-007](../adr/007-in-process-demo-runtime.md) antes de componer runtimes. Antes de integrar evidencia o decisiones, lee [L1 runtime](../architecture/l1-runtime.md), [L2](../architecture/l2-implementation-contract.md) y [L3](../architecture/l3-implementation-contract.md). Los contratos y ADR vigentes prevalecen sobre ejemplos de tutorial.
4. Empieza **solo B0**: inventario, instalación reproducible, comprobaciones basales, procedencia, diseño de composición y propuesta del siguiente incremento. Todavía no construyas toda la app ni configures proveedores. Usa el [formato de entrega y revisión](orchestration-review.md).
5. Presenta el resultado al usuario para revisión en esta sesión. Una vez revisado B0, el usuario podrá encargar B1. En cada bloque autorizado, completa implementación, checks y recorrido local antes de entregar; plantea preguntas únicamente por información o acciones humanas necesarias.

**Salida de B0:** informe verificable, problemas reproducidos, versiones elegidas y diferencias justificadas, rutas de destino, alcance B1 y estado exacto del árbol. No basta responder con otro plan genérico.

## Contexto que no debes tener que redescubrir

- Praeco ya contiene paquetes de evidencia, kernel, intake, harness y SQL financiero. Reutilizar interfaces probadas es distinto de reutilizar la interfaz rechazada. El monorepo usa npm workspaces, TypeScript strict y `npm run check` con build antes de typecheck/tests.
- Última observación de esta sesión: HEAD `916777f`; build configurado pasó y typecheck falló por resolución de `pg`/tipos en `financial-store-sql`, aunque están declarados. Los tests no llegaron a ejecutarse. Revalidar: esta es evidencia histórica, no diagnóstico del estado que encuentres.
- La referencia está en `/Users/moebious/Work/praeco-references/ai-teammates`, base `de32f461cc9e0ddf4c5087af07c65cf06df7d683` con parches locales sin commit. No es suficiente revisar solo upstream. El [manifiesto](reference-baseline-manifest.json) identifica archivos y versiones observados; comprueba diferencias antes de usarlos.
- Si ese checkout no está disponible en tu máquina, informa la falta y pide su ubicación o un snapshot saneado de los archivos elegidos; el commit upstream no incluye los parches locales. Continúa el inventario de Praeco, sin sustituir silenciosamente la referencia por otro estado ni pedir archivos de credenciales.
- Se probó respuesta del bot desde la interfaz. Se probaron además streaming, herramienta sintética y consumo con OpenRouter. El usuario aportó un recorrido Daytona con archivos y escritorio; esto no acreditó L1/L2 integrados. Historial después de reiniciar ambos procesos sigue siendo una prueba exigida al baseline nuevo, no un éxito heredado.
- La referencia quedó detenida por petición del usuario: app, worker y sandbox. No necesita estar funcionando para arrancar B0. Mantén sus archivos y configuración intactos.
- No se copian sus instrucciones `AGENTS.md`: sus reglas sobre commits en main, descarte de datos, `db:push` y despliegue automático no aplican a Praeco. Tampoco se trasladan `.env`, credenciales, IDs de proyectos ni bases de datos.

## Reglas del encargo

- **Identidad Praeco:** todos los nombres, metadata, favicon, navegación, mensajes y artefactos del producto son propios. La referencia se documenta como procedencia de ingeniería, fuera de los bundles y de la experiencia del usuario. Conserva avisos de terceros que exija una licencia; quitar branding no autoriza quitar atribuciones exigibles. El baseline contiene la regla de procedencia antes de copiar.
- **Fidelidad:** conserva el stack, organización y comportamiento detallados en B1–B5. Registra toda desviación con motivo, efecto y prueba. Las adaptaciones de identidad, especialistas precargados, permisos, OpenRouter y sandbox bajo demanda están acordadas; no son invitación a rediseñar todo.
- **Finanzas después de B6:** ningún mensaje, script de sandbox ni LLM concede autoridad financiera. L1 produce evidencia; L2 decide; L3 coordina con permisos. Nunca pagos reales ni equivalentes de `PAID`; únicamente datos sintéticos.
- **Configuración progresiva:** prepara nombres y validaciones; el usuario introduce valores locales cuando el bloque los necesita. Mantén CI offline. Muestra errores accionables y conserva borradores. No declares estable una pantalla cuyo envío no llega al worker.
- **Git:** cumple `AGENTS.md`, Conventional Commits y revisión por bloque. Propón `codex/praeco-workspace` y comprueba colisiones antes de crearla cuando se autorice implementar. No hagas commits en main ni incluyas cambios ajenos. Un bloque aceptado no habilita por sí solo push, merge, deploy o el siguiente bloque.

## Prompt inicial para pegar en OpenCode

```text
Trabaja en /Users/moebious/Work/praeco. Tu encargo está en
docs/product/opencode-execution-brief.md: léelo junto con AGENTS.md y sigue
sus enlaces de arranque. Codex actuará como revisor mediante informes que
yo llevaré entre ambas sesiones; no asumas comunicación automática.

Queremos reproducir fielmente el baseline técnico y el recorrido probado,
con identidad exclusiva Praeco: login, especialistas precargados, chat real,
historial y Daytona antes de integrar L1/L2. No rescates la UI anterior.

En esta primera entrega ejecuta solamente B0. Revisa el árbol y preserva
cambios existentes; verifica instalación/checks, procedencia y composición.
Entrega el formato de docs/product/orchestration-review.md con evidencia,
desviaciones y propuesta concreta de B1. No implementes todavía B1 ni hagas
commits, push, merge, despliegues o provisión de servicios.
```
