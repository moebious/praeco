# B2 — Evidencia de revisión del acceso autenticado

**Fecha:** 2026-10-18. **Base:** `74759c7`, rama `feat/web-finance-workspace`, cambios locales sin commit.
**Estado:** implementación revisada y pruebas offline ejecutadas; aceptación humana con Clerk real pendiente.

## Alcance inspeccionado

Rutas sign-in/sign-up, `proxy.ts`, `lib/auth-config.ts`, `lib/auth.ts`, proveedor de Clerk, menú de sesión y `/api/session`. La sesión validada por Clerk determina usuario/tenant; el acceso inicial concede únicamente `member`. Cada handler privado debe verificar identidad y ownership junto al dato.

## Evidencia automática

En la auditoría previa a las correcciones, `fnm exec --using=22.23.2 npm run check` completó build, tipos y lint. El workspace pasó **49 tests**, incluidos auth, configuración y contenido demo. El check global terminó con un timeout de DocJev en otro paquete; no se registra como validación global verde.

`test/auth.test.ts` utiliza el SDK de Clerk simulado y credenciales exclusivamente sintéticas. No contacta al proveedor ni demuestra que unas claves reales funcionen. Cubre:

| Caso | Resultado comprobado offline |
| --- | --- |
| Sin claves | Pantallas demo disponibles; API de identidad responde 503, sin identidad inventada |
| Configuración parcial o de entorno incorrecto | Acceso privado bloqueado con 503 y mensajes sin secretos |
| Sesión ausente | API directa responde 401; enlace profundo redirige al login conservando destino |
| Sesión válida simulada | Identidad y tenant derivados de la sesión verificada, no del navegador |
| Organización activa simulada | Tenant de organización; rol financiero no concedido automáticamente |
| Logout/expiración simulados | La siguiente llamada vuelve a verificar y rechaza la sesión ausente |
| Error del SDK | Respuesta saneada, sin filtrar la excepción o la clave |
| Token/clave del proveedor | El secret permanece en entorno servidor; no se propaga como clave dinámica |

## Checkpoint real pendiente

La validación global posterior a las correcciones terminó en verde: **348 tests aprobados / 5 SQL omitidos**, incluyendo **90 tests del workspace**. Véase el [informe de correcciones](../2026-10-18-local-fixes.md). Este resultado conserva la distinción entre mocks de Clerk y una sesión real.

Sin pegar valores ni crear otra cuenta automáticamente:

1. Usar la configuración Development de Praeco y arrancar con `npm run web:workspace`, hostname `localhost`.
2. Abrir una ruta protegida sin sesión y comprobar redirección; iniciar sesión o registrarse y regresar al destino.
3. Consultar `/api/session` con sesión y comprobar identidad/tenant esperados y rol `member`.
4. Cerrar sesión desde el menú y repetir el acceso directo a página/API: login/401 respectivamente.
5. Registrar resultado observado y fecha. La evidencia anterior usa mocks y no sustituye estos pasos.

No marcar B2 aceptado hasta completar este checkpoint. La persistencia conversacional de B3 se revisa y entrega por separado.
