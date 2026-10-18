# Praeco — estación de trabajo de cuentas por pagar

Frame B1, acceso Clerk B2 y metadata conversacional PostgreSQL/Neon B3.
Sin claves de Clerk se conserva la demo local. El chat sigue programado:
no hay proveedor de modelo ni integración financiera conectados.

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

La única migración escribe en **`praeco_workspace`**: `conversations` y
`schema_migrations`. No toca `public`, tablas financieras ni el ledger. No hay
DDL automático desde web. Migración versionada, transaccional e idempotente;
rechaza un checksum modificado en lugar de sobrescribir tablas.

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

Si falta configuración, migración o conexión, la UI informa el problema y no
recurre a conversaciones falsas. Los reads no crean filas; únicamente un click
autenticado sobre un especialista inicializa metadata. El preview indica que
no hay mensajes persistidos: el compositor programado es local y se pierde al
recargar. Trigger será dueño del transcript según el siguiente bloque; Neon no
se presenta como un segundo historial autoritativo.

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

OpenRouter, Trigger.dev y Daytona quedan para incrementos posteriores.
Configurar sus variables no activa sus integraciones.
