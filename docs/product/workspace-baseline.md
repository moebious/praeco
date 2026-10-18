# Praeco — Baseline del workspace antes de integrar finanzas

**Fecha:** 2026-10-18. **Estado:** objetivo de implementación, todavía no alcanzado.
**Decisión del usuario:** login → equipo precargado → chat real e historial → Daytona → integración financiera. Este orden reemplaza la propuesta anterior de posponer Daytona hasta después del expediente financiero.

## 1. Qué significa reproducir el baseline

La referencia es el boilerplate de Code with Antonio probado en esta sesión, incluyendo nuestros parches locales. Se reproduce su composición Next.js/React, acceso Clerk, navegación lateral, chat, streaming y panel de escritorio. Hasta aceptar B6, mantener ese recorrido y su lenguaje visual: no convertirlo en otro dashboard de métricas, introducir otro framework, ni inventar un sistema de diseño nuevo.

La fidelidad comprende estructura, interacciones y stack; la identidad visible será Praeco. La reproducción literal de código o assets depende de la procedencia: no se encontró licencia en el snapshot ni en la consulta de GitHub realizada. Antes de copiar, documentar permiso/licencia aplicable. Mientras falte, implementar el mismo comportamiento con código propio y componentes obtenidos de sus fuentes licenciadas. Esta condición no bloquea inventario ni implementación propia. No eliminar atribuciones que una licencia exija. Ver [procedencia](iterative-adoption-plan.md#2-procedencia-antes-de-copiar-archivos).

Dos fuentes distintas: `package-lock.json`/código locales describen lo que se probó; el commit base identifica upstream. El [manifiesto de referencia](reference-baseline-manifest.json) conserva versiones resueltas y hashes de archivos seleccionados, sin secretos ni implementación copiada. Revalidarlos antes de trasladar un componente.

## 2. Baseline técnico observado y objetivo

Estas son versiones **observadas en el lockfile**, no una afirmación de últimas versiones ni de compatibilidad ya probada en Praeco. Usarlas como primera candidata y fijar las elegidas en el nuevo lockfile. Si una dependencia está ausente, es incompatible o requiere una actualización de seguridad, registrar la evidencia y el cambio mínimo; evitar `latest`, `--force` y `--legacy-peer-deps`.

| Área | Baseline observado | Aplicación en Praeco |
| --- | --- | --- |
| Herramientas | Next `16.3.4`; React/DOM `19.2.8`; TS `5.9.3` | Next App Router, React, strict, npm workspaces. Node `22.23.2` fue el entorno local usado; mantener requisito raíz >=22.12. |
| Estilos | Tailwind/PostCSS `4.3.3`; shadcn `4.21.0`; Base UI `1.8.0` | Preset observado `base-nova`, base neutral, CSS variables, Lucide. No reemplazar Base UI por otra familia por familiaridad. |
| UI de conversación | `ai` `7.0.127`; `@ai-sdk/react` `4.0.130`; Streamdown `2.7.0` | Texto/Markdown, partes de herramientas, streaming, estado y cancelación. Obtener componentes desde fuentes licenciadas. |
| Acceso | `@clerk/nextjs` `7.9.9`; `@clerk/ui` `1.38.0` | Development, sign-in/sign-up, protección servidor, regreso al workspace; sin Billing. |
| Ejecución de chat | Trigger SDK/build/CLI `4.7.3`; config del worker `node-24` | Mantener el transporte de chat probado en B4. Worker remoto y Node local son entornos distintos; comprobar ambos. |
| Inferencia | `@openrouter/ai-sdk-provider` `3.1.0` | OpenRouter explícito; sin Neon AI Gateway ni fallback implícito. Modelo por configuración y validación actual. |
| Conversaciones | Drizzle ORM `0.45.3`; Kit `0.31.11`; `pg` `8.23.1` | PostgreSQL/Neon dev dedicado para metadata conversacional; transcript según storage configurado de Trigger. No son el ledger. |
| Formularios | Zod `4.6.5`; RHF `7.89.0`; resolvers `5.9.1` | Validación servidor; schemas de inputs excluyen identidad, permisos y campos generados. |
| Escritorio | Daytona SDK `0.222.0`; noVNC `1.7.0`; resizable panels `4.14.1` | Solo B5 y bajo demanda; noVNC importado en cliente, SDK/secretos en servidor. |
| Detalles | next-themes `0.4.6`; Lucide `1.49.0`; DiceBear core/styles `10.7.0`/`10.6.0` | Tema claro/oscuro, iconos, avatares propios o licenciados. Verificar licencia de cada estilo de avatar. |

La referencia tenía ESLint `10.11.0` y un fallo de compatibilidad del plugin React en el lint observado. No importar ese fallo como baseline aceptable: elegir una combinación compatible documentada y ejecutar lint del workspace. Sus nueve tests locales y typecheck históricos no sustituyen checks de Praeco.

Antes de escribir Next/AI SDK/Trigger, consultar documentación correspondiente a las versiones elegidas: en Next, guías distribuidas en `node_modules/next/dist/docs` si existen. Las skills del repositorio de referencia sirven de consulta, no sustituyen instrucciones ni autorizan despliegues en Praeco.

## 3. Forma inicial del proyecto

Destino propuesto `apps/finance-workspace`, package `@praeco/finance-workspace`. Confirmar en B0 que no existe ni choca con trabajo concurrente. Mantener paquetes financieros donde están. La app anterior puede quedar temporalmente en el árbol, fuera del recorrido de aceptación; retirarla tendrá su propio alcance.

**Retirada autorizada (2026-10-18):** el usuario aprobó retirar `apps/finance-dashboard` como cambio separado, sin esperar la integración financiera del workspace. Se eliminan `web` y `l2:web`, sin repuntarlos. Los paquetes, pruebas de dominio y demos CLI permanecen; se acepta temporalmente la ausencia de demo financiera en navegador. Esta retirada no constituye aceptación del reemplazo.

```text
apps/finance-workspace/
  app/
    layout.tsx                 # estilos, tema, tooltip/toast, proveedor auth cuando esté configurado
    globals.css
    (workspace)/layout.tsx     # sesión + sidebar + contenido
    (workspace)/page.tsx       # equipo inicial y acceso a conversaciones
    (workspace)/chats/[chatId]/page.tsx
    sign-in/[[...sign-in]]/page.tsx
    sign-up/[[...sign-up]]/page.tsx
    api/health/route.ts        # liveness saneada, sin secretos
  components/
    app-sidebar.tsx, chat-header.tsx, chat.tsx, chat-avatar.tsx
    desktop-panel.tsx, theme-provider.tsx
    ui/                        # únicamente primitivas utilizadas
    ai-elements/               # únicamente piezas utilizadas
  actions/chat.ts              # auth + ownership + entrada validada + adaptador
  queries/chats.ts             # filtros de tenant y acceso
  lib/                        # configuración, perfiles y adaptadores de proveedor
  db/                         # metadata conversacional; no tablas financieras
  trigger/chat.ts              # conversación técnica; ninguna mutación financiera
  proxy.ts, components.json, next.config.ts, tsconfig.json
  package.json, .env.example
```

Es un mapa de responsabilidades, no una orden de crear archivos vacíos. Mantener separación RSC/cliente, alias `@/*` local a la app y configuración root compatible con paquetes construidos. Montar Clerk cuando corresponda a B2; B1 conserva modo demo explícito sin claves. No importar workers, SDK servidor, pools o configuración secreta en el grafo cliente.

Proponer scripts `web:workspace` y build/lint/typecheck/test por workspace. En B1 integrar su build y validaciones en el check raíz de forma explícita, conservando el build previo de paquetes. Al aceptar el reemplazo, apuntar la entrada local principal a la nueva app; no cambiar `npm run web` a una pantalla incompleta sin documentarlo.

## 4. Fidelidad de interfaz y diferencias acordadas

| Superficie | Reproducir | Diferencia necesaria |
| --- | --- | --- |
| Frame | Sidebar colapsable a iconos, contenido a altura de viewport, búsqueda, selección activa, footer de usuario | Nombre y navegación Praeco; equipo disponible desde el primer acceso. |
| Sidebar | Conversaciones con avatar, nombre, preview y actividad; estado abierto recordado | IDs y acceso definidos por servidor/tenant; sin crear un bot para empezar. |
| Header | Altura observada `h-12`, avatar/nombre, control del panel lateral | Perfil visible no concede autoridad. Antes de B5, escritorio indica capacidad no configurada en vez de fallar al abrir. |
| Transcript | Columna central observada `max-w-3xl`, scroll, Markdown/código y cards de herramientas con estado/resultado | Errores y carga visibles; no reproducir el historial que quedaba vacío mientras cargaba ni fallos reportados solo al log. |
| Composer | Entrada multilínea, envío y Stop durante streaming | Borrador recuperable ante error; no paywall. Pruebas de teclado y envío duplicado. |
| Estética | Neutral claro/oscuro, bordes discretos, tipografía Geist/sans y mono si disponible con licencia, radio base observado `0.625rem` | Identidad Praeco; fuentes locales/licenciadas cuando el build deba funcionar sin descargar fuentes. No usar logo ni favicon de la referencia. |
| Panel desktop | Split horizontal redimensionable, conexión/reconexión, pantalla ampliable, vista pasiva e interacción explícita | Recurso ligado a tarea/tenant, no una VM permanente por especialista. |
| Inicio | Acceso directo al trabajo, sin pantalla técnica de autenticación como destino | Vera, Kael y Nova precargados; sin formulario «New bot», checkout ni precios. |

Para B1 validar desktop 1440×900 y viewport estrecho 390×844 como objetivos de prueba: sidebar utilizable, composer visible, scroll independiente, sin desbordes. No son tamaños medidos previamente en la referencia. Capturar ambas vistas con datos sintéticos; separar parecido visual de funcionamiento demostrado. El panel de caso financiero se añade después de B6, conservando el frame aceptado.

Los grupos, edición arbitraria de instrucciones, handoff entre bots, memoria persistente, canales externos, pricing, Sentry, Railway y despliegue quedan fuera de B0–B6. La estructura puede admitirlos después; no exponer controles inertes como funciones listas.

## 5. Composición: conservar el recorrido sin duplicar autoridad

**Conversación en vivo de B4:** navegador → transporte Trigger para `useChat` → acciones autenticadas → sesión y token acotados a conversación → worker chat → OpenRouter. Cargar el transcript autorizado antes de inicializar el historial de `useChat`; mostrar carga, fallo y reintento. Un token público de chat no es la clave secreta del worker.

**Persistencia conversacional de B3–B4:** PostgreSQL guarda identidad/acceso de conversación y metadata necesaria. En la referencia, el texto completo se obtiene mediante el default transcript storage de Trigger, no desde `chats.lastMessagePreview`. Verificar el storage efectivo y la retención de la nueva configuración. Identificar dueño de cada dato; no mantener dos copias autoritativas del transcript sin contrato de sincronización. Cerrar/abrir chat, recargar, reiniciar web y worker deben recuperar mensajes completos sin duplicarlos. Si solo se prueba reload, marcar pendiente la prueba de reinicio.

**Separación financiera:** este worker solo conversa y ejecuta herramientas técnicas permitidas. No dispara un segundo runner financiero, escribe ledger, crea grants ni aprueba casos. ADR-007 sigue rigiendo la demo de L3 en proceso. Integrar Trigger/Postgres como propietario del workflow financiero requiere la pista posterior y sus pruebas; la persistencia de mensajes no demuestra esa integración. No anunciar durabilidad financiera entre procesos.

**Identidad:** una identidad Praeco por tenant, tres perfiles estables versionados. Conversaciones con acceso de usuario explícito; cualquier colaboración compartida futura requiere membresía autorizada, no solo coincidir en tenant. Sembrar perfiles de forma idempotente no crea sandboxes, grants ni delegaciones. `userId`, tenant, rol y permisos proceden del servidor. El browser puede elegir un ID permitido, nunca crear autoridad con él.

**Datos:** modelar conversaciones/participantes/uso según esos contratos, sin copiar `bots.sandboxId NOT NULL` ni el modelo de un propietario/una VM por personaje. Esquema conversacional separado de las tablas financieras. Confirmar destino antes de aplicar DDL, con método versionado y acotado a su esquema; no ejecutar el `db:push` del tutorial sobre el monorepo ni sobre la base financiera.

## 6. Bloques de baseline y criterio de cierre

Completar un bloque, entregar evidencia y revisarlo antes del siguiente. El [protocolo](orchestration-review.md) distingue resultado automático, validación humana y aceptación. Cada fila puede dividirse si el cambio deja de ser pequeño.

En B0, registrar primero `git status --short`, rama y HEAD, y leer manifests/lockfile; después ejecutar desde la raíz, con el Node local usado en esta sesión:

```sh
fnm exec --using=22.23.2 npm ci
fnm exec --using=22.23.2 npm run check
```

Son comandos para el ejecutor, **no ejecutados al redactar este baseline**. Si fnm o esa versión no están disponibles, localizar un Node compatible y registrar versión/comandos efectivos antes de instalar. Si falla `npm ci`, resolver o reportar esa causa antes de interpretar fallos posteriores. Instalar desde lockfile no justifica cambios automáticos a dependencias ni un commit vacío.

| Bloque | Trabajo y commit candidato | Evidencia mínima de cierre |
| --- | --- | --- |
| B0 · Inventario y base | Estado del árbol, procedencia, versiones candidatas, instalación desde lockfile, checks raíz y composición. `docs(web): define reference-faithful workspace baseline` | Registrar fallo preexistente y solución si procede; check reproducible. Inventario de archivos elegidos con hash y tratamiento. Rutas y diferencias listas para revisión. Ningún servicio provisionado. |
| B1 · Boilerplate visual offline | Estructura Next/React/Tailwind/shadcn, tema, frame, sidebar, header, transcript/composer programados. `feat(web): add reference-faithful workspace foundation` | Build/lint/check; prueba de navegación, teclado, scroll, claro/oscuro y dos viewports. URL local y capturas. Sin claves; modo demo explícito. Aceptación visual humana antes de ampliar. |
| B2 · Clerk | Sign-in/sign-up, protección servidor, redirección al producto y logout. `feat(web): add authenticated workspace access` | Acceso directo sin sesión y regreso al destino; expiración/logout; acción directa sin sesión denegada; ausencia de clave accionable. El usuario introduce credenciales dev locales. |
| B3 · Equipo y metadata | Vera/Kael/Nova, IDs estables y conversaciones autorizadas; store conversacional dev. `feat(web): persist built-in specialist conversations` | Repetir init y entrar de nuevo no duplica; preview/selección correctos; user/tenant ajeno no accede por URL ni acción. Reiniciar conserva metadata. Todavía no declarar chat real operativo. |
| B4 · Chat real e historial | Transporte y worker Trigger, OpenRouter, texto y herramienta sintética de solo lectura; coste por step y errores visibles. Separar commits de transporte/proveedor cuando convenga. `feat(web): connect metered specialist chat` | Enviar desde UI, ver ejecución del worker y respuesta, Stop, error/retry, tool card y consumo. Cargar historial tras recarga y reiniciar ambos procesos, sin duplicados; autorización en start/token/transcript. No herramientas financieras ni shell todavía. |
| B5 · Daytona antes de finanzas | Recurso técnico bajo demanda y panel, herramientas acotadas, archivo/informe/captura sintéticos. `feat(daytona): add scoped workspace sandbox sessions` y `feat(web): add sandbox desktop inspection` | Credencial validada primero sin VM; tarea explícita con un recurso. Leer/escribir archivo, inspeccionar escritorio y descargar artefacto autorizado. Cerrar/reconectar sin crear VM duplicada; detener y verificar estado/coste. Pruebas negativas de acceso y credencial ausente. |
| B6 · Estabilización | Corregir fallos del recorrido B1–B5, documentación de arranque, checklist repetible y reporte de revisión. `test(web): verify the complete workspace baseline` | Check/lint/build verdes; pruebas manuales registradas; reinicios y configuración faltante probados; revisión de identidad/bundles y ausencia de secretos. Usuario acepta el recorrido completo. Después habilitar F1. |

**Smokes B4:** máximo tres llamadas pequeñas, sin retries automáticos, timeout y límites de tokens/pasos; presupuesto operativo inicial USD 0,05, no anunciado como garantía de hard cap. Comprobar modelo/config actual y coste de cada paso; conservar metadatos raw antes de agregarlos. Si falta coste, detener y conciliar, sin tarifa GPT heredada. Elegir modelo explícitamente según [auditoría](llm-selection-audit.md), revalidando disponibilidad al ejecutar.

**Smokes B5:** una tarea técnica sintética, no una validación financiera. Usar staging explícito y límites de comando, tiempo y tamaño. SDK/credenciales y URL firmada se resuelven tras verificar acceso en servidor. URLs/tokens no quedan en transcript ni logs. El sandbox no recibe claves de L2/SQL/Clerk/Trigger/OpenRouter; el worker conserva el proveedor. No ejecutar instrucciones de archivos como autoridad. Registrar cancelación, desconexión y cleanup. Revisar el aislamiento de Chromium antes de repetir `--no-sandbox`; silenciar el aviso no valida aislamiento.

**Contrato de comandos:** al cerrar B1, documentar comandos exactos desde raíz y workspace para instalar, validar y arrancar. Al cerrar B4, añadir comando CLI/worker y forma de cargar entorno dev; CLI/SDK/build deben coincidir. No mezclar flags inventados de otra versión. El puerto candidato es 3010; comprobar disponibilidad. Usar `localhost` consistentemente: se observó un bucle de rewrite Clerk con hostname `127.0.0.1` mezclado con `localhost`.

## 7. Configuración progresiva

Solo nombres en `.env.example`; valores en archivos ignorados. No abrir/imprimir/copiar el `.env.local` de la referencia. Cada proceso debe cargar explícitamente la configuración de Praeco. Las claves antiguas pueden estar revocadas; el éxito histórico no acredita las actuales. Reiniciar consumidores tras cambios.

| Bloque | Nombres esperados | Comprobación |
| --- | --- | --- |
| B1 | Ninguno obligatorio | Arranca modo demo offline; no conecta proveedores ni pools al importar módulos. |
| B2 | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`; URLs de sign-in/sign-up y retorno a `/` | Instancia Development; secret solo servidor. No usar `/auth-check` como destino del producto. Definir vínculo dev usuario/tenant en servidor, sin conceder FinanceAdmin automáticamente. |
| B3 | `DATABASE_URL`; conexión DDL separada solo si el mecanismo elegido la necesita | DB/schema dev conversacional identificado; pooled para tráfico cuando corresponda; validar sin imprimir URL. No reusar implícitamente credenciales de L2. |
| B4 | `TRIGGER_PROJECT_REF`, `TRIGGER_SECRET_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Ref `proj_…`, entorno Development y worker registrados; secreto de Trigger solo backend. OpenRouter sin fallback y token público scoped distinto del secret. Claves en los procesos que las consumen, sin sync automático a producción. |
| B5 | `DAYTONA_API_KEY`; endpoint/target únicamente si la configuración lo requiere | Configuración explícita servidor/worker; inicialización diferida. No crear VM al arrancar web, acceder o sembrar perfiles. |

Sin Billing en este producto inicial: quitar esa dependencia, conservar auth/ownership y límites de consumo. No hace falta trasladar la flag del tutorial como contrato permanente. Reservas operativas de inferencia y recursos son distintas del presupuesto financiero L2.

## 8. Identidad, procedencia y revisión del build

Las superficies del producto usan exclusivamente Praeco: nombre de paquete/app, metadata/títulos, textos, manifest, favicon/logo, errores, prompts de identidad y artefactos exportados. No incluir enlaces promocionales, nombres del tutorial o del autor, README/diagrama de la referencia ni créditos promocionales en la app.

La trazabilidad de ingeniería permanece en estos documentos y el manifiesto, fuera de `app`, `public` y del grafo de imports del build. Mantener avisos legales exigibles en el lugar que establezca la licencia, aunque no sean parte de la UI. Esto no equivale a ocultar procedencia ni cambiar autoría.

En B6, buscar los términos de branding de la referencia y sus URLs en código propio de la app, assets, metadata y outputs de cliente/servidor. Revisar cada coincidencia; separar una atribución exigible de una filtración de branding. Verificar que no se empaquetan docs de ingeniería, claves, datasets oracle, tests o fuentes ajenas mediante imports/copia de carpetas. Registrar comando, alcance y resultado; no concluir que una búsqueda de cadenas prueba por sí sola ausencia de secretos.

## 9. Paso a finanzas

Solo después de B6 aceptado: seguir F1–F6 del [plan iterativo](iterative-adoption-plan.md#5-secuencia-de-incrementos). Conectar evidencia L1, preview L2, decisión simulada, aprobación humana financiera y expediente. Añadir herramientas por puertos protegidos; no sustituirlas por Python/LLM ni dar autoridad al transcript o al sandbox. El cambio de workflow financiero a Trigger y de stores financieros/operativos a SQL conserva su pista y pruebas propias.
