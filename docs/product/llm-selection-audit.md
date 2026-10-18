# Auditoría de modelos LLM para Praeco

**Fecha de consulta:** 2026-10-18. **Estado:** recomendación para evaluación; proveedor y modelo no implementados por este documento.

## Recomendación

Evaluar primero **`anthropic/claude-sonnet-5.5`** en OpenRouter para el L3 conversacional de Praeco y para probar la referencia AI Teammates. Elegir **`anthropic/claude-haiku-5.5`** como alternativa económica para el primer smoke y tareas acotadas si supera las mismas pruebas de permisos y fidelidad. Ambos IDs figuran en el [catálogo público consultado](https://openrouter.ai/api/v1/models).

La preferencia por Sonnet es una hipótesis de ingeniería: ofrece herramientas, visión y salidas estructuradas documentadas para coordinar especialistas y explicar registros. No hemos medido que sea más preciso, rápido o económico por caso resuelto que los demás. La calidad en español, seguimiento de instrucciones y resistencia a inyección quedan pendientes de evaluación. Las etiquetas comerciales de capacidad o velocidad de los fabricantes no son resultados de Praeco.

La elección está condicionada a que el adaptador preserve streaming, llamadas y resultados de herramientas, bloques de razonamiento y consumo. Si falla esa compatibilidad, no resolverla quitando validaciones ni cambiando automáticamente a otro modelo; registrar el fallo y evaluar el siguiente candidato.

## Límites del producto

- [L1](../architecture/l1-runtime.md) produce evidencia verificada; esta selección no sustituye sus parsers, extractor ni política de readiness. Que un modelo lea una imagen no convierte una factura en evidencia autorizada.
- [L2](../architecture/l2-implementation-contract.md) es la única autoridad financiera. El modelo explica resultados almacenados o propone comandos mediante herramientas protegidas; nunca calcula un veredicto alternativo ni modifica el ledger. Conservar `AUTHORIZED_SIMULATED`, `BLOCKED` y `PENDING_HUMAN_APPROVAL`.
- [L3](../architecture/l3-implementation-contract.md) utiliza una identidad por tenant y perfiles Vera/Kael/Nova, con contexto autenticado inyectado por servidor y herramientas específicas. El [registro actual](../../packages/agent-harness/src/specialists/registry.ts) valida argumentos y rol; eso no acredita por sí solo todos los requisitos adversariales.
- [ADR-007](../adr/007-in-process-demo-runtime.md) conserva la demo y CI offline con modelos programados, store en memoria y ejecución dentro de un proceso. Un adaptador LLM en vivo es optativo; no aporta durabilidad entre procesos ni exige Trigger.dev/Neon para la demo.
- Solo datos sintéticos; ninguna prueba realiza pagos, transmite credenciales o usa números de cuenta reales.

## Comparación verificable

Precios base publicados en USD por millón de tokens de entrada/salida, sin caché, batch, búsquedas u otras herramientas facturadas. Contexto es el máximo anunciado, no una recomendación de tamaño de prompt. Datos obtenidos del [catálogo OpenRouter](https://openrouter.ai/api/v1/models) y contrastados con las fuentes oficiales enlazadas por fila.

| ID de OpenRouter | Entrada / salida | Contexto | Imágenes; tools; structured outputs | Papel propuesto |
| --- | --- | --- | --- | --- |
| `anthropic/claude-sonnet-5.5` | $2 / $10 | 1.000.000 | Sí; sí; sí | Candidato principal para coordinación y explicación; [ficha oficial](https://platform.claude.com/docs/en/models/sonnet-5-5/overview) |
| `anthropic/claude-haiku-5.5` | $0,10 / $0,50 hasta 100k de prompt; tramo superior $0,50 / $2,50 | 1.000.000 | Sí; sí; sí | Alternativa económica, validar antes de ampliar tareas; [ficha y tramos](https://platform.claude.com/docs/en/models/haiku-5-5/overview) |
| `google/gemini-4-argon` | $2 / $10 | 1.048.576 | Sí; sí; sí | Comparador multimodal, sin ventaja económica base frente a Sonnet; [capacidades oficiales](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon) |
| `deepseek/deepseek-v4.1-flash-1017` | $0,15 / $0,60 fuera de punta; $0,30 / $1,20 en punta | 1.048.576 | Sí; sí; sí según catálogo | Comparador económico con snapshot explícito; validar strict y transporte; [modelo y tarifas oficiales](https://api-docs.deepseek.com/quick_start/pricing/) |

Los cuatro figuran como compatibles con `tools`, `tool_choice`, `response_format` y `structured_outputs` en el catálogo, pero esos indicadores no garantizan todos los valores o esquemas en cada proveedor. Haiku cuesta 20 veces menos por token que Sonnet en su tramo corto; el coste total puede diferir por razonamiento, repetición y número de pasos. DeepSeek publica tarifas por horario; su alias sin fecha tiene otra tarifa de catálogo y no debe intercambiarse silenciosamente con el snapshot.

No es un ranking exhaustivo: el catálogo también contiene familias más recientes que las usadas originalmente por la referencia. No se ha elegido una versión antigua por familiaridad ni se declara que esta muestra contenga el mejor modelo del mercado.

## Condiciones del adaptador y contabilidad

1. Usar ID explícito y registrar modelo/proveedor efectivos, versión de prompt y herramientas, tokens y coste. No emplear router automático ni fallback a otro modelo durante la comparación. Registrar cualquier cambio posterior y reevaluarlo.
2. Sonnet 5.5 rechaza herramientas forzadas: emplear `tool_choice: auto`; cuando admita strict, el esquema debe cerrar propiedades adicionales. Sus cambios de razonamiento y streaming requieren revisar el transporte de bloques. [Guía de migración](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide).
3. Haiku 5.5 requiere omitir parámetros de sampling heredados y conservar correctamente el historial de razonamiento; un límite de salida bajo puede consumirse antes del texto visible. Cambiar de modelo o proveedor a mitad de conversación exige verificar compatibilidad del historial. [Guía de migración](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide).
4. En DeepSeek, el modo strict nativo es beta; no inferir que OpenRouter reproduce esa garantía por mostrar `structured_outputs`. [Documentación de herramientas](https://api-docs.deepseek.com/guides/tool_calls/).
5. Verificar el endpoint efectivo y exigir los parámetros necesarios con `provider.require_parameters`; evitar proveedores sin las capacidades requeridas. La disponibilidad de strict depende del endpoint; no basta el ID del modelo. [Routing](https://openrouter.ai/docs/guides/routing/provider-selection), [salidas estructuradas](https://openrouter.ai/docs/guides/features/structured-outputs).
6. Validar argumentos en el servidor incluso con strict: rechazar tenant/actor/decision falsificados, claves desconocidas y campos fuera del contrato. La corrección del JSON no concede permisos ni prueba evidencia.
7. La visión de escritorio de la referencia usa capturas y herramientas propias: no necesita automáticamente el toolset nativo computer-use de Anthropic. Probar la secuencia captura → image tool result → siguiente llamada, además de la carga de imagen del usuario.
8. Sustituir las tarifas fijas de la referencia; contabilizar razonamiento, caché y tramos cuando corresponda. Reservar coste antes del siguiente paso y conciliar con el consumo real; precio de catálogo no equivale a factura verificada. Definir un límite de pasos, tokens, tiempo y gasto independiente del modelo.

## Evaluación propuesta, todavía no ejecutada

**Primero offline:** probar el adaptador con respuestas y streams falsos, incluyendo tool calls fragmentadas, JSON inválido, campos desconocidos, error/timeout, rechazo, salida truncada, uso ausente y resultado con imagen. Fijar secuencias esperadas de herramientas, permisos e idempotencia sin llamar servicios externos.

**Corpus de Praeco:** recorrer los ocho escenarios Blinka sintéticos mediante L1 real según ADR-007; incluir las dos fuentes del caso 04. El harness de evaluación compara contra resultados esperados fuera del runtime. Los prompts, herramientas y proceso de aplicación no pueden leer ground-truth ni expected outcomes. Ejecutar cada escenario con estado aislado; un replay secuencial que comparta ledger necesita semántica explícita.

**Ataques adicionales:** instrucciones dentro de facturas/correo para saltar gates o revelar secretos; IDs de otro tenant; intento de cambiar cuenta beneficiaria; READY o decisión inventados; herramientas fuera del perfil; argumentos desconocidos; retries/loops repetidos; aprobación resuelta antes de instalar la espera. Los puertos y L2 deben rechazar operaciones aunque el modelo obedezca la inyección.

**Criterios:** ninguna fuga entre tenants, ejecución fuera de permisos, bypass de gates ni compromiso duplicado; toda afirmación financiera apunta al registro real de L2 y toda afirmación documental a evidencia disponible. Responder incertidumbre cuando falten fuentes. Medir fidelidad de explicación y utilidad en español por separado de los resultados financieros deterministas. Un fallo de seguridad bloquea la promoción; no se compensa con promedio de calidad.

**Comparación en vivo posterior:** mismas herramientas, prompts y corpus; medir éxito por tarea, errores de esquema/herramienta, reintentos, coste total por caso y latencia hasta primer token y finalización. Registrar llamadas y seeds si se admiten, sin tratar un seed como garantía determinista. Separar una prueba opcional de capturas de escritorio: aprobar visión no demuestra grounding L1.

**Primer smoke económico propuesto:** Haiku 5.5, texto sintético y una herramienta falsa de solo lectura; como máximo tres llamadas con ≤4.000 tokens de entrada y ≤1.024 de salida por llamada, esfuerzo bajo compatible y timeout. A tarifa corta, el techo nominal de tokens es aproximadamente $0,002736 para las tres llamadas; reservar un presupuesto mayor de $0,05 para la sesión y detenerse ante errores, límites o uso desconocido. Es una propuesta, no una llamada ejecutada ni un tope garantizado por la API. Confirmar tarifa, capacidad de limitar salida/razonamiento y reserva antes de invocar. Daytona y Trigger tienen costes separados.

## Evidencia y pendientes

Se consultaron contratos locales y APIs/documentación públicas sin leer credenciales ni ejecutar inferencias. No se midieron precisión, latencia, disponibilidad con la cuenta del usuario, streaming real, visión ni coste facturado. Una autenticación HTTP 401 es un problema de credencial, carga de entorno, endpoint o formato de autorización: elegir otro modelo no la resuelve. El diagnóstico debe verificar esos factores antes de atribuir la causa a la vigencia de la clave.

La adaptación posterior de la referencia, sus pruebas offline y el intento mínimo de chat rechazado con HTTP 401 están registrados en [PT-007 del handoff](ai-teammates-learning-handoff.md). Esa comprobación no produjo una respuesta del modelo ni midió su calidad.

El usuario aclaró después que la credencial es patrocinada y administrada por la plataforma del hackathon. Se confirmó una ejecución histórica Jev en modo live; el acceso a chat quedó pendiente hasta las comprobaciones siguientes (PT-008 del handoff). La recomendación por catálogo no acreditaba por sí sola disponibilidad con esa credencial.

**Avance posterior de integración:** tras emitir y configurar otra clave del evento, la API pública aceptó la autenticación y Sonnet 5.5 superó un stream de texto y un ciclo de herramienta sintética local. Los resultados y su coste reportado están en PT-008. Esto acredita disponibilidad básica de ese modelo con la nueva clave, no calidad en el corpus financiero, resistencia a ataques, rendimiento comparado ni conversación completa desde la interfaz.

Revisar esta selección al cambiar catálogo, tarifas, SDK/proveedor, contratos, herramientas o corpus. La aprobación del modelo de producción requiere una evaluación con trazas; esta nota permite elegir qué probar primero.
