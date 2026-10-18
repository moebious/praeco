# Praeco — Especificación y handoff desde las pruebas de AI Teammates

**Estado:** exploración de la referencia cerrada por ahora a petición del usuario; handoff listo para iniciar implementación en Praeco. Las propuestas conservan sus estados de aceptación y validación.
**Creado / última actualización:** 2026-10-18.
**Objetivo:** registrar lo observado al probar AI Teammates y convertirlo en cambios concretos para la experiencia de Praeco.

**Continuidad:** el [plan de adopción iterativa con commits y HITL](iterative-adoption-plan.md) convierte estos hallazgos en bloques de implementación, checkpoints humanos, configuración de servicios y criterios de avance. Es una propuesta; los bloques no están ejecutados.

**Ejecución acordada:** otro agente, en OpenCode, implementará; esta sesión revisará sus entregas. Empezar por el [brief inicial](opencode-execution-brief.md), que remite al [baseline fiel B0–B6](workspace-baseline.md) y al [formato de revisión](orchestration-review.md). El usuario eligió estabilizar login, equipo precargado, chat real e historial y Daytona **antes** de integrar finanzas. El producto tendrá identidad Praeco, sin branding promocional de la referencia.

Registrar un requisito no significa que esté implementado o validado. Los contratos y ADR vigentes conservan autoridad. Una propuesta que los cambie requiere su proceso de decisión correspondiente.

## Cómo continuar las pruebas

1. Probar una interacción y registrar el resultado visible o la limitación encontrada.
2. Añadir una entrada con ID estable, evidencia, comportamiento deseado, área afectada y criterios de aceptación.
3. Distinguir observación, dirección acordada y propuesta pendiente. Marcar una implementación como verificada únicamente con evidencia de ejecución.
4. Antes de implementar, revisar el código vigente y los contratos enlazados.

Guardar resultados sin credenciales ni contenido financiero real. Las pruebas financieras utilizan datos sintéticos; los resultados esperados del golden set permanecen exclusivamente en tests.

## Base de comparación y límites

- **Referencia:** [AI Teammates](https://github.com/code-with-antonio/ai-teammates/tree/de32f461cc9e0ddf4c5087af07c65cf06df7d683), commit `de32f461cc9e0ddf4c5087af07c65cf06df7d683`, con cambios locales de autenticación, inicialización diferida de Daytona y modo sin suscripción. La prueba local puede diferir del original.
- **Evidencia de interfaz:** resultados reportados por el usuario, complementados con registros y comprobaciones locales. El usuario confirma que el bot se guarda y responde en el chat. Después compartió la transcripción de un escenario con archivos, Python Decimal, Chromium y herramientas de escritorio; su alcance y límites se registran en PT-010. El adjunto de texto no incluye la imagen original de la captura ni una descarga independiente de los archivos.
- **Praeco:** [contrato L3](../architecture/l3-implementation-contract.md), [contrato L2](../architecture/l2-implementation-contract.md) y [ADR-007](../adr/007-in-process-demo-runtime.md). Leer [L1 runtime](../architecture/l1-runtime.md) antes de integrar o cambiar evidencia.
- **Demo vigente:** runtime determinista en un proceso, memoria y modelos programados detrás de puertos. Trigger.dev y PostgreSQL/Neon son destinos de sustitución; la demo no demuestra durabilidad entre procesos.
- **Autoridad:** L1 produce evidencia; L3 coordina trabajo y permisos; L2 determina el resultado financiero. La interfaz conserva `AUTHORIZED_SIMULATED`, `BLOCKED` y `PENDING_HUMAN_APPROVAL` según L2. Una aprobación humana conserva las restricciones de los gates duros.

## Registro de hallazgos y requisitos

### PT-001 — Especialistas disponibles desde el primer acceso

**Observado:** la referencia muestra «Meet your first bot» y «New bot / Give it a face, a name, and a job to do», con elección de avatar. El usuario define bots antes de utilizarlos.

**Dirección acordada:** Praeco incluye Vera, Kael y Nova preconfigurados para empezar sin escribir instrucciones ni crear personajes.

| Perfil | Responsabilidad visible | Herramientas y autoridad |
| --- | --- | --- |
| Vera | Analizar documentos y explicar evidencia e incertidumbres | Ingesta y consulta mediante L1; sin autoridad financiera |
| Kael | Explicar políticas y verificaciones | Evaluación de solo lectura mediante L2 y explicación de sus registros |
| Nova | Consultar alcance delegado y proponer autorización simulada | Consulta y propuestas por puertos protegidos; L2 resuelve |

**Diseño propuesto:** catálogo versionado con ID estable, nombre, avatar, descripción, instrucciones y herramientas. Una identidad Praeco por tenant utiliza los perfiles según el contrato L3. Los permisos se resuelven en el servidor; precargar una persona no crea delegaciones financieras ni presupuestos.

**Áreas afectadas:** catálogo, inicialización del workspace, navegación/conversaciones e integración con `packages/agent-harness`.

**Base existente:** [WorkflowRunner](../../packages/agent-harness/src/workflow-runner.ts) registra herramientas de los tres perfiles. Esta estructura en código no demuestra integración completa con la interfaz.

**Criterios de aceptación propuestos:**

- Un workspace nuevo muestra exactamente tres perfiles iniciales sin «New bot».
- Repetir la inicialización conserva IDs y conversaciones, sin duplicar perfiles ni recrear permisos.
- Los perfiles y conversaciones respetan el aislamiento entre tenants.
- Las herramientas corresponden al perfil y permisos vigentes, incluso si un mensaje intenta cambiar sus instrucciones.
- La demo ofrece los perfiles sin exigir un sandbox por personaje.

**Estado:** integración de producto y verificación de extremo a extremo pendientes.

### PT-002 — Acceso autenticado al espacio de trabajo

**Observado:** tras autenticarse, el usuario veía «You're signed in / Authentication is working», una comprobación técnica en lugar del producto.

**Propuesta pendiente:** dirigir al workspace autorizado o a la conversación solicitada. Conservar la comprobación técnica como herramienta de desarrollo si hace falta.

**Áreas afectadas:** autenticación, redirecciones y pantalla inicial.

**Criterios de aceptación propuestos:** una sesión nueva llega al producto; una URL protegida recupera su destino tras acceder; cerrar sesión impide consultar conversaciones protegidas.

**Estado:** hallazgo registrado; revisar autenticación vigente de Praeco antes de trasladar código.

### PT-003 — Probar el flujo sin bloqueo comercial

**Observado:** la referencia bloqueaba bots por plan. Se deshabilitó localmente el requisito comercial con una opción explícita y se pudo abrir «New bot». Se conservaron autenticación, propiedad de recursos y límites de consumo.

**Dirección acordada para la prueba:** explorar sin contratar el plan comercial de la referencia. Esto no decide el modelo comercial de Praeco.

**Propuesta:** el recorrido de demo con especialistas incluidos funciona sin suscripción de bots; acceso, consumo y política financiera conservan controles independientes.

**Áreas afectadas:** onboarding, disponibilidad de funciones y límites.

**Criterios de aceptación propuestos:** iniciar el recorrido sintético sin checkout; mostrar un estado accionable si falta configuración; la ausencia de suscripción no concede permisos financieros.

**Estado:** bloqueo comercial desactivado localmente en la referencia; modelo comercial de Praeco sin decidir.

### PT-004 — Separar especialistas de infraestructura opcional

**Observado en código y ejecución:** `actions/bot.ts` llama a `createBotSandbox` antes de guardar el bot y su chat. Sin credenciales Daytona, guardar fallaba (PT-005).

**Propuesta alineada con ADR-007:** precargar perfiles y recorrer la demo determinista sin Daytona, Trigger.dev, Neon ni claves de modelos en vivo. Habilitar capacidades externas mediante adaptadores y configuración explícita.

**Áreas afectadas:** inicialización, composición del runtime, estados de capacidades y guía de arranque local.

**Criterios de aceptación propuestos:** catálogo y recorrido sintético sin claves externas; indicar capacidades sin configurar; explicar que reiniciar el proceso pierde el estado en memoria de la demo.

**Estado:** base de runtime aceptada en ADR-007; experiencia integrada pendiente de verificar.

### PT-005 — Errores de configuración con una acción concreta

**Observado:** al guardar aparecía «Couldn't create the bot / Something went wrong. Try again.». Los registros mostraban varios HTTP 500 y `DaytonaAuthenticationError: Authentication credentials not found`, desde `getDaytona` → `createBotSandbox` → `createBot`, antes de la transacción de base de datos. Las consultas de disponibilidad de uso respondían HTTP 200.

**Causa confirmada:** faltaba la credencial del SDK Daytona. Desactivar el requisito comercial no configura servicios externos. Esos intentos fallidos no llegaron a crear bot ni solicitar sandbox.

**Avance verificado:** el usuario añadió `DAYTONA_API_KEY` al archivo local ignorado; la consulta de autenticación Daytona respondió HTTP 200 y se reinició el servidor. Esa comprobación no creó recursos. Después, el usuario confirmó que el bot se guarda; la conversación sigue pendiente.

**Propuesta:** comprobar dependencias por capacidad y mostrar un error específico con una acción útil. Los usuarios sin permisos de configuración reciben una indicación para contactar al administrador.

**Áreas afectadas:** configuración de adaptadores, respuestas del servidor y mensajes de interfaz.

**Criterios de aceptación propuestos:** distinguir configuración ausente, caída temporal y consumo agotado; identificar capacidad y siguiente paso sin claves ni trazas; conservar formulario al fallar; evitar recursos huérfanos; mantener disponible la demo si la dependencia externa es opcional.

**Estado:** bloqueo de guardado resuelto según reporte del usuario. Mejora de errores en Praeco propuesta, sin implementación.

### PT-006 — Distinguir bot guardado de conversación operativa

**Observado:** el bot se guarda, pero el usuario no puede interactuar con él. Las rutas de conversación responden HTTP 200; eso no demuestra envío ni respuesta.

**Diagnóstico inicial:** la referencia usa Trigger.dev para sesión, token y ejecución (`actions/chat.ts`, `components/chat.tsx`, `trigger/chat.ts`). Al detectar el fallo faltaban `TRIGGER_PROJECT_REF` y `TRIGGER_SECRET_KEY`. La invocación directa de `auth.createPublicToken`, operación usada por el chat, fallaba con `ApiClientMissingError` indicando que faltaba `TRIGGER_SECRET_KEY`; tampoco había un worker de desarrollo conectado.

**Siguiente dependencia identificada inicialmente:** `lib/model.ts` usaba Neon AI Gateway y faltaban sus dos variables. Se adaptó posteriormente a OpenRouter (PT-007); la ruta de inferencia devuelve HTTP 401. El síntoma visual exacto del compositor y su recuperación siguen pendientes de comprobar.

**Siguiente paso de la referencia:** elegir y configurar el proveedor del modelo (la alternativa OpenRouter se registra en PT-007) y probar un turno completo, verificando que la aplicación entregue la sesión al worker registrado. Las claves permanecen locales y no se requiere desplegar a producción.

**Avance de configuración:** el usuario añadió las variables, corrigió el Project ref y autorizó el CLI en el navegador. El CLI 4.7.3 coincide con SDK/build instalados, sin cambiar dependencias del proyecto. El worker confirmó `Local worker ready` en Development, rama `default`, runtime `node-24`, versión `20261018.1`, y registró `chat`. Se cargó `.env.local` con el modo sin suscripción activo y concurrencia máxima 1. La aplicación Next.js fue reiniciada y `/api/health` respondió HTTP 200. La generación de token de chat funciona, sin exponerlo. El gateway continúa sin configurar; la entrega de una sesión desde la interfaz y una respuesta completa siguen pendientes de validar.

**Propuesta:** distinguir perfil disponible y ejecución disponible. Mostrar el runtime seleccionado (demo determinista o adaptador externo) y el motivo de bloqueo; guardar un perfil no demuestra que pueda responder.

**Áreas afectadas:** capacidades, compositor, historial, ejecución y guía de arranque.

**Criterios de aceptación propuestos:**

- Un especialista indica si puede responder con el runtime activo.
- Los errores de historial, autenticación o ejecución muestran un siguiente paso; no dejan pantalla vacía ni espera indefinida.
- Un mensaje no enviado conserva su borrador y permite reintento tras recuperar el servicio.
- Una prueba completa acredita envío, ejecución y recepción visible; guardar o abrir la ruta con HTTP 200 no basta.
- La conversación de demo de ADR-007 funciona sin estos servicios y se identifica como respuesta programada.

**Estado actual:** CLI y worker listos, modelo OpenRouter configurado y autenticación recuperada con una clave nueva (PT-008). Streaming y una herramienta local sintética probados en vivo. El usuario confirmó después que recibió una respuesta del bot desde la interfaz; las herramientas reales de Daytona siguen pendientes. Requisito de Praeco propuesto, sin implementación.

### PT-007 — Proveedor LLM sustituible: alternativa OpenRouter

**Consulta del usuario:** usar OpenRouter en lugar de habilitar Neon AI Gateway para los modelos de los agentes.

**Observado en código:** `lib/model.ts` centraliza el proveedor mediante `chatModel()` y selecciona `neon("gpt-5")`. Los bots comparten ese modelo y reciben instrucciones y herramientas propias. `chatModelCost()` contiene tarifas fijas que también se usan para contabilizar y limitar el consumo durante el turno. La base de datos PostgreSQL de Neon tiene una responsabilidad independiente del gateway LLM.

**Viabilidad:** OpenRouter ofrece una API compatible con OpenAI y una integración con Vercel AI SDK; véase su [documentación oficial](https://openrouter.ai/docs/community/frameworks). La referencia usa AI SDK 7: la implementación debe verificar compatibilidad de versiones del adaptador, sin asumir que cualquier ejemplo publicado encaja directamente.

**Propuesta pendiente de implementación:** sustituir o seleccionar el proveedor detrás de `chatModel()`, configurar clave e ID de modelo OpenRouter en el entorno local y ajustar el cálculo de costes. El cambio mantiene Trigger.dev para ejecución, Daytona para herramientas/sandbox y Neon PostgreSQL para datos. Registrar proveedor, modelo y base de cálculo del consumo sin exponer credenciales.

**Áreas afectadas en la referencia:** `lib/model.ts`, dependencias si son necesarias, configuración local y contabilidad en `trigger/chat.ts`. Las claves se pasan también al worker de Development; no se copian a producción.

**Criterios de aceptación propuestos para la adaptación y el handoff a Praeco:**

- Un turno completo responde mediante OpenRouter y transmite la respuesta a la interfaz.
- Se valida llamada de herramienta y retorno de su resultado; si se habilita uso de escritorio, se valida también entrada de imagen con un modelo que la admita.
- Proveedor/modelo son configuración explícita; las instrucciones de cada especialista conservan sus límites de autoridad.
- La contabilidad corresponde al modelo seleccionado, con una fuente de costes documentada; no se reutilizan silenciosamente las tarifas fijas de otro modelo.
- Límites de consumo y errores de credencial/modelo siguen siendo visibles y verificables. La demo determinista de Praeco permanece disponible sin claves.

**Selección para evaluación:** `anthropic/claude-sonnet-5.5` como candidato principal y `anthropic/claude-haiku-5.5` como alternativa económica. La [auditoría de modelos](llm-selection-audit.md) compara catálogo, capacidades, condiciones de integración y evaluación pendiente. La recomendación no acredita precisión o latencia medidas en Praeco. El usuario pidió auditar y elegir el modelo con base en esa comparación.

**Implementación en la referencia:** adaptador `@openrouter/ai-sdk-provider` 3.1.0, compatible con AI SDK 7. Con `OPENROUTER_API_KEY` presente se exige `OPENROUTER_MODEL`; sin esa clave se conserva el proveedor Neon original. Se configuró localmente el ID Sonnet 5.5. Se usan costes reportados por OpenRouter por paso, acumulados en estado aislado del run y reiniciados por turno; el agregado de tokens de AI SDK descarta esos costes crudos. Cada paso se redondea hacia arriba a millonésimas de USD. Coste ausente/inválido detiene el turno en lugar de aplicar tarifas de otro modelo. Una interrupción sin informe final de consumo sigue siendo una limitación de conciliación con la factura real.

**Diagnóstico de credencial:** una sola definición de la clave en `.env.local`, formato completo esperado y sin espacios; su valor coincide con `OPENROUTER_API_KEY` de `.env.openrouter.local` de Praeco, sin mostrarlo. Los endpoints de cuenta `/api/v1/key`, `/api/v1/auth/key` y `/api/v1/credits` respondieron HTTP 401 `User not found`. El listado `/api/v1/models/user` respondió HTTP 200 también sin clave y con una clave ficticia de control: no acredita autenticación. Se intentó un chat sintético mínimo con Sonnet y máximo 32 tokens; `/api/v1/chat/completions` respondió el mismo HTTP 401, sin respuesta ni reporte de consumo. Se confirma el rechazo actual de la ruta de inferencia, sin atribuirlo a un error de copia o afirmar la causa interna de la cuenta.

**Validación ejecutada:** nueve tests offline verdes (cuatro de integración/configuración/costes del modelo y cinco existentes de facturación), `npm run typecheck` exitoso y `git diff --check`. Las pruebas de modelo cubren imagen como resultado de herramienta y dos pasos SSE con llamada/resultado de herramienta, incluyendo pérdida de coste crudo en el agregado. El worker se reinició y registró `chat`, build `20261018.4`, con el entorno local actualizado. Estas pruebas no son una conversación real ni una evaluación de los escenarios financieros.

**Estado actual:** proveedor adaptado y modelo elegido para evaluación en la referencia; autenticación y smokes de streaming/herramienta recuperados tras actualizar la clave (PT-008). El usuario confirmó una respuesta del bot desde la interfaz. El código de Praeco conserva su implementación; se añadieron documentos de especificación y auditoría.

### PT-008 — Credenciales patrocinadas y acceso por endpoint

**Contexto aportado por el usuario:** la clave procede de la plataforma del hackathon, con USD 50 de crédito según su panel; se administra allí, no desde una cuenta propia de OpenRouter. El saldo y sus condiciones no se han verificado mediante API. Se conserva esa clave y se retira la recomendación previa de crear otra en el panel público de OpenRouter hasta entender la integración del evento.

**Evidencia adicional:** se revisaron los registros de la [ejecución Jev 39093326642](https://github.com/moebious/praeco/actions/runs/39093326642). Indican `mode: live`, proveedor OpenRouter, dos intentos y dos resultados `pass` con categoría `invoice`. Se distingue de la ejecución 39091803095, que fue un preflight local. Esto confirma una prueba Jev en vivo exitosa; el secreto de GitHub no es legible y no se afirma haber comparado su valor con la clave local.

**Diferencia verificada:** el experimento Jev usa el protocolo TypeSafe mediante `TYPESAFE_BASE_URL=https://openrouter.ai/api`; OpenRouter documenta su [Decisions API](https://openrouter.ai/blog/insights/what-is-jev/) en `/api/alpha/decisions`. La referencia conversacional llama a `/api/v1/chat/completions`. Una ejecución exitosa de Jev no demuestra acceso a Sonnet ni a cualquier otro modelo/endpoint. El HTTP 401 de chat tampoco demuestra por sí solo que el crédito del evento haya expirado.

**Hipótesis pendientes:** URL o autenticación específica de la plataforma, permisos distintos por endpoint/modelo, o cambios de estado de la credencial/cuenta desde la ejecución anterior. Ninguna se da por confirmada. Se solicitó al usuario la URL base o ejemplo público de integración del evento, sin la clave; no se cambia el destino de la credencial por conjetura.

**Hallazgo posterior al consultar el panel:** el usuario compartió una vista enmascarada de la clave activa y un presupuesto declarado de USD 50 asignados, USD 8,27 gastados, USD 36,73 disponibles y USD 5 reservados para evaluaciones. Son cifras reportadas por el panel, no conciliadas por API. Se comparó únicamente la terminación visible de esa clave con el valor efectivo de la aplicación y con su archivo `.env.local`: no coincide. La copia local `.env.openrouter.local` de Praeco sigue teniendo el mismo valor que la referencia y tampoco coincide con la terminación del panel. No se expusieron las claves ni se ejecutaron inferencias para esta comparación.

**Acción inmediata:** copiar la clave activa del evento al `.env.local` de la referencia, verificar la coincidencia con el panel y repetir la validación de autenticación antes de cambiar endpoints o emitir otra credencial. La discrepancia entre la configuración local y la clave mostrada es un hecho comprobado; no se afirma que la clave local haya sido revocada ni que se conozca el motivo interno del HTTP 401. Los permisos del gateway se revisarán si el rechazo persiste con la credencial correcta.

**Propuesta para Praeco:** configurar el adaptador con origen, mecanismo de autenticación, modelo y capacidades explícitos del proveedor. Mantenerlos bajo control del servidor y fuera de prompts o argumentos que un modelo pueda modificar. Documentar el origen del cupo y sus restricciones sin tratar el saldo declarado como consumo conciliado.

**Áreas afectadas:** configuración de proveedores, diagnóstico de autenticación y disponibilidad de modelos.

**Criterios de aceptación propuestos:** una credencial del evento utiliza solo el endpoint acordado; se diferencia autenticación rechazada de modelo no habilitado o crédito agotado; el acceso a clasificación no anuncia automáticamente capacidad conversacional; los mensajes explican el siguiente paso sin exigir administrar una cuenta que el usuario no controla.

**Resolución posterior:** el usuario revocó la credencial anterior y emitió otra desde el evento. La referencia carga un valor nuevo que coincide con su archivo local; `/api/v1/key` respondió HTTP 200. El endpoint público de OpenRouter funciona con esa credencial: no fue necesario cambiar su origen. Se conservan los errores anteriores como evidencia histórica, sin atribuir una causa interna no observada al rechazo de aquella clave.

**Pruebas en vivo ejecutadas tras la actualización:**

- Un stream de Sonnet 5.5 produjo texto y finalizó normalmente en un paso, con coste reportado redondeado de 86 millonésimas de USD.
- Un segundo smoke hizo exactamente una llamada a `localEcho`, herramienta sintética local sin efectos externos, y respondió con el marcador retornado. Fueron dos pasos, coste reportado redondeado de 2.582 millonésimas de USD y finalización normal.
- El total de ambos smokes es aproximadamente USD 0,002668 en el medidor; no equivale a una conciliación del saldo o factura del evento.
- Next.js y el worker se reiniciaron con la nueva configuración; el worker registró `chat` y `/api/health` respondió HTTP 200.
- Se abrió una pestaña temporal para comprobar la interfaz. Mostró el acceso de Clerk sin sesión autenticada; no se inició sesión ni se envió un mensaje de usuario. Se cerró esa pestaña. El turno completo dentro de la aplicación queda pendiente de la sesión del usuario.

**Dependencia restante:** la copia local de la credencial de Jev en Praeco conserva el valor anterior; no se modificó. Una nueva prueba en vivo de Jev requerirá actualizar su configuración de credenciales por separado.

**Estado:** bloqueo de autenticación de la referencia resuelto; streaming y herramienta sintética validados en vivo. Posteriormente, el usuario confirmó respuesta del bot en la interfaz. Herramientas de Daytona y evaluación financiera de Praeco pendientes; estos smokes no validan esos recorridos.

### PT-009 — Activación del sandbox y visibilidad del escritorio

**Confirmación del usuario:** el bot respondió en el chat y el siguiente objetivo de prueba es activar su sandbox Daytona.

**Comportamiento comprobado en código:** el sandbox ya se crea al guardar el bot (`actions/bot.ts`). `getBotSandbox` recupera ese recurso y lo arranca si no está iniciado. Las herramientas de shell/archivos lo solicitan cuando lo necesitan; las herramientas gráficas inician además el servicio `computerUse`.

**Recorrido de la referencia:** en el chat individual, pulsar el icono de monitor de la cabecera, con nombre accesible `Desktop`, abre el panel. `getDesktopUrl` comprueba propiedad, acceso y uso, arranca el sandbox si hace falta y obtiene la vista noVNC. Los chats grupales no muestran ese botón porque reúnen varios sandboxes. Pedir `showScreen` al bot también activa el escritorio y devuelve una captura al transcript; `viewScreen` solo proporciona una imagen al modelo.

**Prueba propuesta al usuario:** abrir `Desktop` y pedir que ejecute `pwd` y `uname -s`, muestre la salida y luego una captura del escritorio. Son operaciones de inspección del entorno sintético; no requieren documentos financieros ni crear otro sandbox.

**Propuesta para Praeco:** si se habilita el adaptador opcional de escritorio, hacer visibles su disponibilidad y estado, distinguir abrir la vista de ejecutar herramientas y mostrar errores accionables. Esta prueba no convierte Daytona en requisito del catálogo de especialistas o del recorrido determinista de ADR-007.

**Criterios de aceptación propuestos:** un recurso existente se reutiliza al reabrir; la ejecución se vincula al perfil/trabajo autorizado; una captura solicitada se ve en la conversación; la ausencia de configuración o la desconexión no se presentan como una tarea completada.

**Estado:** instrucciones verificadas por lectura del código. La transcripción posterior del usuario muestra shell, apertura de Chromium y herramientas de pantalla/clic (PT-010). La apertura específica del panel noVNC y la inspección independiente de la captura no están acreditadas por ese adjunto de texto.

### PT-010 — Expediente sintético: resultado del primer escenario Daytona

**Entrada y evidencia:** transcripción aportada por el usuario del caso OC-DEMO-001 / FAC-DEMO-042. Los dos documentos se generaron a partir del prompt en `~/praeco-demo/`; esto prueba preparación de archivos sintéticos, no ingesta independiente ni verificación documental de L1.

**Observado en la transcripción:** el bot ejecutó comandos, creó `orden-compra.txt` y `factura.txt`, generó `generar_informe.py` e `informe.html`, abrió el informe con Chromium y utilizó `viewScreen` y clics. La respuesta incluye el marcador de una captura mostrada al usuario y aclara que solo enseña la parte superior del informe. El adjunto no contiene la imagen; no se afirma haberla inspeccionado ni haber descargado los archivos del sandbox.

**Resultado revisado:** el script lee los archivos y usa `Decimal`. La orden contiene 10 licencias a USD 100,00 y total USD 1.000,00; la factura, 12 al mismo precio y total USD 1.200,00. Una comprobación independiente con Decimal confirmó consistencia interna, diferencia de 2 licencias y USD 200,00 (20 %). Proveedor, referencia, periodo y precio unitario coinciden en las entradas. Esto valida esos cálculos concretos; no acredita extracción general ni seguridad de autorización financiera.

**Límite conservado:** el informe declara «Expediente preparado; sin evaluación de L2», identifica faltantes y no afirma haber verificado beneficiario/cuenta, presupuesto ni autorización. Una aprobación de licencias adicionales que se solicite como contexto deberá tener la evidencia y autoridad requeridas; nunca sustituye por sí sola el contrato vigente ni permite omitir un gate duro de L2.

**Cambios propuestos para Praeco y criterios de aceptación:**

- **Fuentes verificables:** el expediente consume referencias y resultados tipados de L1; enlaza fuentes inmutables y evidencia concreta. Un nombre de archivo escrito por el modelo no acredita esa verificación.
- **Cálculos y errores:** presentar resultados de componentes deterministas y errores estructurados ante importes inconsistentes o campos ausentes. El `assert` del script de demostración abortaría la generación si fallaran las sumas; ese comportamiento debe convertirse en un estado comprensible y trazable del producto.
- **Artefactos accesibles:** ofrecer vista completa y descarga de informe/fuentes, vinculadas al caso y protegidas por tenant. Una captura parcial no es el único acceso al expediente.
- **Trazabilidad:** asociar acciones, herramientas, salidas y artefactos al Assignment/caso; distinguir ejecución técnica de herramienta, preparación del informe y veredicto financiero retornado exclusivamente por L2.

**Detalle del runtime observado:** Chromium se lanzó con `--no-sandbox` y se cerró su aviso. Ocultar el aviso no modifica ese flag; revisar la composición del navegador forma parte de una eventual integración de escritorio, separada de la validación de contenido del informe. La prueba no acredita una configuración de producción.

**Siguiente comprobación sugerida:** pedir al bot que muestre las secciones inferiores de discrepancias y preguntas sin alterar fuentes, y comprobar el acceso a los artefactos. La conexión real con L1/L2 permanece fuera de esta prueba de referencia.

**Estado:** escenario completado según la transcripción del usuario y aritmética revisada independientemente. Captura original, archivos remotos, persistencia entre reinicios, correlación de casos, gates financieros e integración Praeco todavía no validados por este escenario.

## Próximas interacciones por explorar

Registrar resultados al probar; esta lista no acredita disponibilidad ni aceptación para Praeco.

| Interacción | Pregunta para la prueba |
| --- | --- |
| Conversación individual | ¿Cómo presenta actividad, errores, historial y consumo? |
| Conversación con varios bots | ¿Cómo se elige quién responde y cómo se muestra un traspaso? |
| Adjuntar documentos | ¿Cómo se suben, vinculan y consultan sus fuentes? |
| Herramientas y tareas | ¿Qué progreso y resultados puede inspeccionar el usuario? |
| Revisión humana en Praeco | ¿Cómo añadir decisión, evidencia y acciones autorizadas? |

## Primer handoff de implementación propuesto

**Alcance actualizado:** B0 de inventario y reproducibilidad, seguido del baseline B1–B6 con revisión por entrega. PT-001 entra en ese baseline; el catálogo ya no se propone como una migración aislada que preceda a toda definición del boilerplate.

**Entregable de la primera ejecución:** informe B0 verificable y alcance B1 listo para revisión. El baseline completo tendrá tres perfiles, inicialización repetible, login, chat real, historial y escritorio; distinguir lo programado de lo probado en vivo.

**Validación al implementar:** criterios PT-001, aislamiento, inicialización repetida y permisos de herramientas; ejecutar `npm run check` para cambios de código. Una captura del catálogo no acredita conversación completa ni seguridad financiera.

**Decisiones de alcance actualizadas:** conversaciones individuales en el baseline; grupos y edición arbitraria de nombres/instrucciones quedan para después. Elegir avatares propios o con licencia comprobada antes de incorporar esos recursos.

## Cierre de la exploración y continuidad en Praeco

**Solicitud del usuario:** parar las pruebas de la referencia y continuar en Praeco. La evidencia reunida basta para iniciar una integración acotada de experiencia y herramientas; no se presenta como validación completa de Praeco.

**Estado operativo al cerrar:** se detuvieron el servidor Next.js en localhost:3010 y el worker Trigger.dev. Se consultaron los bots de la base tutorial y se detuvo su único sandbox Daytona después de verificar que su etiqueta correspondía al bot registrado. La API confirmó el estado `stopped`. Se conservan el sandbox, sus archivos, los registros de la base y los cambios locales de la referencia. El puerto local quedó sin servidor escuchando. No se revocaron claves durante este cierre.

**Orden de implementación actualizado por el usuario:**

1. B0: inventario, procedencia y validación reproducible. La interfaz actual fue descartada por inutilizable; el PR #14 no es un prerrequisito ni una base obligatoria. Inventariar el harness y sus contratos por separado para reutilizar lo probado.
2. B1–B4: reproducir fielmente el frame y recorrido del boilerplate con identidad Praeco, login, Vera/Kael/Nova precargados, chat real e historial. Validar desde la interfaz y después de reinicios. La demo offline permanece disponible, diferenciada del adaptador en vivo.
3. B5–B6: probar Daytona con una tarea técnica sintética y estabilizar el recorrido completo antes de integrar finanzas. Ningún perfil necesita una VM para existir. Este sandbox no aporta autoridad financiera.
4. F1–F6: conectar un caso sintético a L1/L2 y L3, mostrar fuentes, estado operativo, decisiones y artefactos; ampliar a ocho escenarios, permisos adversariales, revisión humana e idempotencia. El informe consume resultados verificados. Mantener el oracle fuera del runtime y verificar por separado la persistencia financiera entre procesos.

**Reutilización a evaluar:** patrones de conversación, presentación de herramientas, manejo de errores y vista de escritorio. Antes de trasladar código o recursos gráficos, revisar sus licencias y su encaje con los contratos de Praeco. La suscripción comercial de la referencia, su bot genérico por usuario y sus sesiones no se trasladan como autoridad de permisos o decisiones financieras.

**Primer hito de producto actualizado:** B6, baseline técnico estable y aceptado por el usuario. El expediente que recorre fuentes reales de L1 y evaluación real de L2 corresponde al tramo financiero posterior. La selección del modelo sigue siendo un candidato para evaluar, no una garantía de seguridad. Usar `npm run check` para el cambio de código y registrar resultados concretos antes de declarar un hito completado.

## Historial

| Fecha | Cambio | Evidencia / alcance |
| --- | --- | --- |
| 2026-10-18 | PT-001 a PT-004 | Prueba guiada, formulario reportado y lectura de código/contratos |
| 2026-10-18 | PT-005 | Registros confirman falta de credenciales Daytona antes de guardar |
| 2026-10-18 | Avance PT-005 | Autenticación HTTP 200, reinicio y confirmación de guardado del usuario |
| 2026-10-18 | PT-006 | Falta de configuración Trigger reproducida con SDK; gateway sin configurar |
| 2026-10-18 | Recuperación del documento | El archivo dejó de estar presente tras cambios concurrentes de checkout; se recuperó el contenido de trabajo de esta conversación y se añadió PT-006, sin modificar código |
| 2026-10-18 | Avance PT-006 | Token Trigger generado tras añadir variables; Project ref pendiente de corrección antes de arrancar el worker |
| 2026-10-18 | Configuración PT-006 | Project ref corregido; CLI 4.7.3 preparado y autorización reanudable pendiente del usuario |
| 2026-10-18 | Worker PT-006 | Usuario autorizó CLI; worker Development listo y `chat` registrado, Next.js reiniciado y health HTTP 200. Sin desplegar ni llamar al modelo |
| 2026-10-18 | PT-007 | Consulta sobre OpenRouter: proveedor LLM independiente de PostgreSQL, compatibilidad y costes pendientes de adaptación |
| 2026-10-18 | Adaptación y auditoría PT-007 | Sonnet 5.5 seleccionado para evaluar; adaptador y contabilidad por paso en la referencia, nueve tests offline y typecheck verdes. Inferencia mínima rechazada con HTTP 401 pese a coincidencia de clave con configuración Jev |
| 2026-10-18 | PT-008 | Clave patrocinada según usuario; ejecución histórica Jev live verificada. Pendiente contrato de integración del evento; no inferir caducidad ni pedir otra clave pública |
| 2026-10-18 | Hallazgo PT-008 | La terminación de la clave local no coincide con la clave activa mostrada por el panel del evento; actualizar la referencia antes de cambiar el gateway |
| 2026-10-18 | Resolución PT-008 | Usuario emitió una clave nueva; autenticación HTTP 200 y smokes de streaming y herramienta sintética correctos. App/worker reiniciados; interfaz autenticada pendiente |
| 2026-10-18 | PT-009 y avance PT-006 | Usuario confirma respuesta del bot en la interfaz; se documenta cómo abrir el escritorio y solicitar herramientas Daytona, todavía sin validar esos recorridos |
| 2026-10-18 | PT-010 y avance PT-009 | Transcripción del expediente sintético con shell, Decimal, HTML y escritorio. Cálculos revisados; fuentes verificables, acceso a artefactos y trazabilidad propuestos para Praeco |
| 2026-10-18 | Cierre de referencia | Usuario pidió continuar en Praeco. App y worker detenidos; único sandbox de referencia verificado y detenido, conservando archivos. Handoff y siguiente integración documentados |
