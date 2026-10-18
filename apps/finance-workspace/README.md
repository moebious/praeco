# Praeco — estación de trabajo de cuentas por pagar

Frame B1, acceso Clerk B2, metadata conversacional PostgreSQL/Neon B3 y chat
OpenRouter + Trigger.dev B4. Sin claves de Clerk se conserva la demo local.
El chat no tiene autoridad financiera ni herramientas de pago.

## Estado del bloque

- Frame de la estación de trabajo: barra lateral colapsable a iconos, header de
  12 unidades, transcripción y compositor multilínea.
- Tema claro/oscuro (base neutra, radio base `0.625rem`) y tipografía variable
  local (paquete `geist`): el build no descarga fuentes.
- Equipo precargado (Vera, Kael, Nova) y conversaciones con contenido
  **programado**. El modo demo se declara explícitamente en la interfaz.
- El control de escritorio informa **no configurado** en lugar de fallar: el
  adaptador llega en un bloque posterior.
- Con ambas claves Development de Clerk: registro, login, protección de páginas
  y API en servidor, y cierre de sesión desde el menú de usuario. Una clave
  faltante o de formato inválido bloquea el acceso, sin volver a modo demo.
- Los usuarios autenticados tienen conversaciones privadas por tenant **y usuario**.
  Cada perfil tiene ID/version estable; abrirlo prepara las tres conversaciones
  sin duplicarlas. PostgreSQL conserva IDs, títulos, preview y fechas, **no mensajes**.
  Login no concede FinanceAdmin.
- Con OpenRouter y Trigger.dev Development configurados, los chats autenticados
  usan un modelo explícito y el transcript de Trigger. El servidor comprueba
  tenant y propietario; Neon guarda solo metadata y recibos de uso/costo.
  La única herramienta disponible inspecciona capacidades sintéticas y de solo
  lectura. No se exponen documentos, decisiones, aprobaciones ni pagos al modelo.

## Comandos

```bash
npm run dev        # next dev en el puerto 3010
npm run build      # next build
npm run lint       # eslint (flat config, ESLint 9)
npm run typecheck  # tsc --noEmit
npm test           # vitest run
npm run db:status  # comprobación de lectura, schema y TLS del cliente
```

Desde la raíz del repositorio:

```bash
npm run web:workspace   # servidor de desarrollo local
npm run check           # build + typecheck + lint + test de todos los paquetes
```

## Configuración

La demo no requiere credenciales. Para habilitar Clerk:

1. En una aplicación **Development** de Clerk dedicada a Praeco, habilita el
   método de acceso que quieras probar (por ejemplo email). No hace falta Billing.
2. Edita **localmente** `.env.local` en la raíz de Praeco (ignorado por git).
   Añade `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` y `CLERK_SECRET_KEY` de la misma
   aplicación Development, con prefijos `pk_test_` y `sk_test_`. No pegues valores
   en chats, capturas, comandos de shell ni commits. No copies el entorno de la
   aplicación de referencia.
3. Reinicia `npm run web:workspace` desde la raíz. Usa siempre
   `http://localhost:3010`, no mezcles el hostname con `127.0.0.1`.
4. Abre `/` sin sesión: debe ir a `/sign-in`. Regístrate o inicia
   sesión; Clerk conserva el destino de retorno y usa `/` como fallback.
5. Comprueba `/api/session`: devuelve solo la identidad verificada, tenant y rol
   `member`, sin tokens ni claves. El tenant es la organización activa verificada
   o un espacio privado derivado del usuario, nunca un valor del browser.
6. Usa el menú del avatar para cerrar sesión. Acceder de nuevo al workspace debe pedir
   login; `/api/session` sin sesión debe responder 401, incluso en acceso directo.

Sin ambas claves, `/sign-in` muestra instrucciones sin inicializar Clerk.
Sin ninguna clave, la demo pública sigue disponible y `/api/session` devuelve
503: **no** inventa una identidad demo autenticada. Con solo una clave o claves
de formato inválido, las páginas y APIs protegidas responden 503.
`/api/health` es público y solo indica liveness, no conectividad con proveedores.
Cambiar claves requiere reiniciar el proceso; no mezcles pares ni entornos.

`lib/server-env.ts` carga el archivo único; `lib/auth-config.ts` comprueba la
configuración de identidad. Los valores permanecen en servidor excepto la clave
publicable de Clerk. No se validan claves contra servicios al arrancar.

```ts
import { describeEnvironment, requireServiceConfig } from "@/lib/server-env"

describeEnvironment()          // nombres y estados; nunca valores
requireServiceConfig("database") // falla cerrado nombrando las variables ausentes
```

La única instancia local es `.env.local` en la raíz del repositorio. La plantilla
sin secretos es `.env.example`, también en la raíz. No crees archivos por
proveedor ni un `.env.local` dentro de esta app; no hace falta una variable de
referencias a otros archivos.

`next.config.ts` lo carga antes de compilar las variables públicas de Clerk;
`instrumentation.ts` y Proxy usan la misma resolución tanto desde la raíz como
desde el workspace. Las variables ya presentes en el proceso tienen prioridad,
incluidos valores vacíos explícitos. Se conservan literalmente los signos `$`
en passwords y claves, sin expansión de variables. Si el archivo no existe,
la demo funciona sin conexiones ni validación contra proveedores. Las pruebas
usan archivos sintéticos aislados, no las credenciales locales.

## Neon: metadata conversacional

`DATABASE_URL` en el mismo `.env.local` apunta a la base **Development** confirmada
por el usuario. Se usa Drizzle y `pg`, con pool diferido (máximo 4 conexiones),
timeouts y verificación TLS para conexiones remotas. No se abre un pool al
importar módulos, compilar o cargar la demo sin autenticación.

Las migraciones escriben únicamente en **`praeco_workspace`**: conversaciones,
control de acceso al chat, recibos de uso y `schema_migrations`. No tocan
`public`, tablas financieras ni el ledger. No hay DDL automático desde web.
Son versionadas, transaccionales e idempotentes; rechazan un checksum modificado
en lugar de sobrescribir una migración aplicada.

Desde la raíz, después de confirmar que el destino es Development:

```bash
npm run db:status --workspace @praeco/finance-workspace
npm run db:migrate --workspace @praeco/finance-workspace -- --apply --schema=praeco_workspace
npm run db:smoke --workspace @praeco/finance-workspace -- --apply --schema=praeco_workspace
```

El smoke crea solo tres filas sintéticas en un scope único, comprueba init
repetido, título conservado con una conexión nueva y rechazo de otro tenant/usuario.
Después elimina sus propias filas. No crea identidades Clerk ni lee mensajes.
Las herramientas no imprimen URL, passwords, claves ni errores raw del proveedor.

Prueba humana tras migrar:

1. Reinicia web, inicia sesión y pulsa Vera, Kael o Nova. Quedan tres conversaciones
   privadas; repetir el click abre el mismo ID.
2. Renombra una conversación con **Guardar título**. Recarga y reinicia web:
   ID y título deben conservarse. La sidebar y el inicio leen metadata autorizada.
3. Otro usuario, aun en la misma organización, no debe poder abrir ese UUID ni
   renombrarlo. Las APIs `/api/conversations` y `/api/conversations/[chatId]`
   vuelven a autenticar y filtran tenant + propietario, sin confiar en el browser.
4. Las rutas antiguas `caso-0142`, etc. pertenecen solo a la demo sin claves; no se
   importan como historial de usuarios autenticados.

Si falta configuración, migración o conexión, la UI informa el problema. Los
reads no crean filas; únicamente un click autenticado sobre un especialista
inicializa metadata. Cuando el chat en vivo no está configurado, la conversación
persistida indica que sus mensajes programados no se guardan. En el modo en vivo,
Trigger es el dueño del transcript; Neon no es un segundo historial autoritativo.

## OpenRouter y Trigger.dev: chat en vivo

Configura `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `TRIGGER_PROJECT_REF` y
`TRIGGER_SECRET_KEY` en el único `.env.local` de la raíz. Usa el proyecto y la
clave **Development** de Trigger, y fija un modelo compatible con herramientas.
`npm run chat:status --workspace @praeco/finance-workspace` solo consulta el
catálogo de modelos, precios y configuración; no realiza inferencia.

Las sesiones se autorizan tras verificar Clerk, tenant, propietario y una
vinculación opaca generada por el servidor. Trigger conserva los mensajes;
Neon conserva el presupuesto y los recibos exactos de costo/uso. Cada chat tiene
un límite de costo de USD 0.05. Cada paso reserva antes de llamar al proveedor,
desactiva reintentos y fallback; si el proveedor no reporta costo, se conserva
una reserva bloqueante. La interfaz permite detener la generación y recuperar
transcripciones anteriores.

Desde la raíz del repositorio, inicia el worker de desarrollo:

```bash
npm run chat:dev --workspace @praeco/finance-workspace
```

El smoke en vivo es una operación de pago y requiere límites explícitos. Envía
solo los dos mensajes sintéticos del script, permite como máximo tres llamadas
y USD 0.05 en total, verifica la herramienta de solo lectura y la recarga del
transcript, y cierra la sesión:

```bash
npm run chat:smoke --workspace @praeco/finance-workspace -- \
  --allow-paid --budget-usd=0.05 --max-calls=3
```

No conectes herramientas financieras ni aumentes esos límites para esta prueba.

## Alcance y pruebas

`npm run check` desde la raíz valida build, tipos, lint y tests offline. Los tests
de auth usan sesiones SDK falsas: configuración parcial, redirección a login,
acceso directo denegado, sesión expirada/cerrada y aislamiento del identificador
de tenant. No necesitan claves ni contactan Clerk. La prueba humana de login,
registro, retorno y logout con claves reales es un checkpoint separado.
Los tests SQL usan PostgreSQL embebido en memoria (PGlite), la migración real y
Drizzle, sin Neon ni claves. Cubren unicidad/concurrencia, ownership, inyección,
recreación del store y replay de migración. No sustituyen el smoke Neon ni la
prueba humana de reiniciar la aplicación.

La protección de Proxy no sustituye controles junto al dato. Cada futura acción
o API privada debe llamar a `requireWorkspaceActor()` desde `lib/auth.ts` y
verificar tenant y ownership del recurso. `requireWorkspacePageAccess()` permite
solo las pantallas sintéticas en modo demo; **no** habilita acciones privadas.
No hay asignación automática de permisos financieros ni persistencia de casos.

Daytona sigue pendiente; configurar sus variables no activa una integración.

## Cuentas por pagar (superficie de aceptación L2)

`/payables` lista los casos sintéticos y `/payables/[caseId]` muestra evidencia,
preview, veredicto y los seis gates del kernel determinista. Los handlers de
servidor `/api/payables/[caseId]/preview`, `/api/payables/[caseId]/decide` y
`/api/payables/[caseId]/approvals/[approvalRequestId]` ejecutan el pipeline L1
real y el kernel L2 real; el navegador nunca decide. Los desenlaces visibles son
exactamente `AUTHORIZED_SIMULATED`, `BLOCKED` o `PENDING_HUMAN_APPROVAL`; nunca
se presenta un estado de pago —ni en inglés ni en español—. Resolver una
aprobación exige el rol `FinanceAdmin`, mapeado solo desde el claim de servidor
`praecoRoles` (`org:admin` **no** lo concede). Sin Clerk se declara
explícitamente un actor sintético de demo. Ante evidencia crítica ausente el caso
falla cerrado: `payable-09` demuestra esa ruta degradada.

Corre sobre el runtime determinista en proceso de ADR-007 (`lib/finance/runtime.ts`,
singleton perezoso y ledger en memoria por `caseId`): **no hay durabilidad entre
procesos** y reiniciar la web reinicia las decisiones. Los sobres L1 se guardan
bajo `.praeco-demo/l1` (ignorado por git; `PRAECO_FINANCE_DEMO_ROOT` permite otra
raíz).

Procedencia de las entradas: los bytes de `fixtures/payable-sources/` (`01.pdf`–`08.pdf`,
`02-context.txt`, `04-context.txt`, `05.txt`) se copiaron byte a byte desde
`packages/evidence-intelligence/test/fixtures/demo-day/sources/`. No se copian ni
se leen en runtime archivos de manifiesto o de resultados esperados
(`index.json` en esa carpeta de fuentes, `original-manifest.json` en el fixture
demo-day, `test/fixtures/corpus/ground-truth.json`): el runtime deriva cada
decisión solo de los bytes de entrada. `09-incomplete.txt` es una entrada
degradada sintética, no una copia.
