# Correcciones de la auditoría local

**Fecha:** 2026-10-18. **Base:** `74759c7`, rama `feat/web-finance-workspace`, sin commits nuevos.
**Alcance:** seis hallazgos de navegación, instrucciones y evidencia; sin integrar finanzas ni aceptar B3.

## Cambios

- Inicio tiene un botón de navegación visible también a 390 px. Elegir una conversación cierra el menú móvil.
- El layout lee `sidebar_state` y pasa su valor inicial al proveedor; una recarga conserva el sidebar cerrado.
- La búsqueda filtra únicamente la lista autorizada recibida, por título y preview, sin distinguir mayúsculas/tildes. Tiene estado sin coincidencias; borrar el texto o pulsar Escape restablece la lista.
- La propuesta Droid CP1–CP4 queda marcada como histórica. El baseline B0–B6 conserva la secuencia vigente; se mantiene la autorización independiente de retirada del dashboard anterior.
- Las instrucciones financieras exigen mostrar el código literal devuelto por L2 junto a cualquier explicación traducida.
- B2 tiene [entrega y matriz de evidencia](b2/auth-review.md), con login/logout real pendientes explícitos.

## Regresión y validación

- Antes del arreglo: `test/navigation.test.ts` produjo **2 fallos y 3 passes**. Los fallos eran la preferencia `false` ignorada y el botón de navegación ausente en inicio.
- Después: `test/navigation.test.ts` y `test/conversation-search.test.ts` produjeron **10 passes** con `fnm exec --using=22.23.2 npm run test --workspace @praeco/finance-workspace -- test/navigation.test.ts test/conversation-search.test.ts`.
- DocJev: la auditoría previa registró un timeout de Vitest a 5 s para un subproceso acotado a 15 s. El suite de procesos ahora permite 20 s al test runner; el timeout del adaptador permanece intacto y el caso explícito de cancelación a 200 ms se conserva. Sus **11 tests pasaron** con `fnm exec --using=22.23.2 npm run test --workspace @praeco/document-classification-adapter -- test/adapter.test.ts`.
- Lint del workspace y enlaces locales de documentación: sin errores en las comprobaciones enfocadas.
- Concurrencia L3: el check en paralelo excedió los límites de 5 s/30 s en segmentación y correlación multicanal. Los mismos **12 tests pasaron con un worker**, incluyendo OCR real que consumió unos 23 s. El script de tests de L3 limita ahora los workers a uno; se conservan sus aserciones y todos los límites del runtime. Esto evita disputar CPU/memoria entre parsers nativos del mismo suite.
- Producción local en `localhost:3012`: búsqueda sin coincidencias, filtrado por `0131`, recuperación con Escape, colapso conservado tras reload y petición HTTP con cookie; portada a 390×844 con menú accesible y cierre del menú al navegar al chat, comprobados en navegador.
- **Check completo: PASS, exit 0.** `fnm exec --using=22.23.2 … npm run check`, con variables de credenciales vacías para validación offline: build, tipos, lint y **348 tests aprobados / 5 SQL omitidos**. Desglose: L3 56, clasificación 22, L1 111, intake 25, kernel 44 y workspace 90. Las cinco pruebas SQL requieren una base de integración configurada; no se presentan como ejecutadas. El workspace incluye tests de metadata añadidos por el otro agente: este resultado automático no equivale a aceptación B3.

## Límites y coordinación

Otro agente siguió trabajando en el checkout con autorización del usuario. Se conservaron sus cambios de metadata conversacional, retirada del dashboard y referencias del kernel/AGENTS; esta entrega no los acredita como integración financiera validada. La primera tentativa de check coincidió con otro `next build`; se esperó su salida sin borrar el lock ni detener el proceso ajeno.

Los checks offline usan credenciales de servicios vacías o stubs sintéticos, sin llamadas a proveedores. La validación automática de identidad usa mocks de Clerk. La aceptación real B2 y la revisión de B3 conservan sus checkpoints separados.

La instancia temporal de producción de esta revisión en el puerto 3012 quedó detenida y la pestaña de pruebas cerrada; se restauró el viewport normal del navegador. No se crearon recursos cloud, ramas, commits, pushes ni despliegues.
