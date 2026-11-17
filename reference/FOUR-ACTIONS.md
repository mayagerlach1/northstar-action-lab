# Guía de conexiones · dashboard integrado

Las cuatro acciones ya están implementadas y parten del elemento que estás analizando en **Overview → Segment → Record**: un KPI, una barra, una celda numérica o la evidencia de un registro. No hay que construir cuatro APIs ni abrir un panel separado. El alumno copia, despliega, personaliza el caso y conecta sus cuentas.

## Recorrido de la clase · 180 minutos

- Copiar y personalizar: 35 min.
- Overview → Email: 30 min.
- Segment → Trello: 30 min.
- Record → corrección numérica Supabase: 35 min.
- Record → issue de GitHub: 30 min.
- Descanso: 10 min. Cierre y demostración: 10 min.

Se puede usar el dataset ficticio incluido o adaptar uno de una clase anterior con el asistente. Si cambia el caso, deben cambiar coherentemente la interfaz, el contexto y registros del servidor, y el seed/IDs permitidos de Supabase. Cambiar etiquetas no cambia lo que se envía. Un borrador de email/Teams puede servir como calentamiento opcional; no demuestra que se haya enviado nada.

## Primero: tu copia y tu clave del laboratorio

1. Despliega tu propia copia del repositorio y abre **su URL principal**.
2. Personaliza el diseño/caso antes de añadir credenciales. La interfaz, datos y botones funcionan al clonar. Puedes abrir previews y confirmar; si faltan conexiones, el error nombra las variables que debes configurar.
3. En **tu Vercel → proyecto → Settings → Environment Variables → Production**, guarda `LAB_ACCESS_KEY`: una contraseña aleatoria de **32–256 caracteres**, conservada también en tu gestor de contraseñas. Hazlo antes de añadir claves de proveedores.
4. Añade las variables del servicio, guarda y entra en **Deployments → último despliegue → Redeploy**.

No hay un flag de activación. Para llamadas reales configuradas, escribe la contraseña del laboratorio en **Connections & lab access** o en el diálogo de la acción. Las API keys van directamente a Vercel o a los ajustes del proveedor, nunca al chat ni a archivos publicados. **Refresh data & connections** consulta los datos y conexiones actuales; no escribe ninguna corrección.

Consulta tu plan y cuotas antes del taller. Las cuentas utilizadas no se han auditado mediante sus pantallas de facturación; una API que responde no acredita que el plan sea Free.

## 1 · Overview: enviar el resumen de la vista por email

**En la app:** ajusta los filtros y pulsa el **KPI** que quieres comentar. En su contexto, elige **Share finding** y edita **destinatario, asunto y mensaje**. Conserva el indicador seleccionado y los filtros, revisa el email exacto y confirma.

1. En [Resend → API Keys](https://resend.com/api-keys), crea una clave de prácticas con **Full access**: permite enviar y consultar después el resultado.
2. Configura `LAB_EMAIL_TO` con la dirección asociada a tu propia cuenta Resend. El remitente incluido es `onboarding@resend.dev`.
3. Guarda en Vercel y redespliega.

| Variable | Valor |
| --- | --- |
| `RESEND_API_KEY` | Tu clave de prácticas Full access. |
| `LAB_EMAIL_TO` | Tu propia dirección asociada a esa cuenta Resend. |

El destinatario es editable, pero la ruta de prueba actual solo autoriza la dirección configurada en `LAB_EMAIL_TO`. Enviar a otras personas requiere un dominio verificado y adaptar expresamente esa restricción.

**Comprobación:** abre el email real en tu bandeja y compara los filtros, el resumen y el identificador. «Aceptado» por el proveedor no demuestra llegada al buzón. Un estado pendiente se consulta sin volver a enviar el mensaje.

## 2 · Segment: convertir el diagnóstico en una tarea Trello

**En la app:** pulsa la **barra** de la región o categoría que quieres investigar. En el contexto de esa barra, elige **Assign investigation** y edita título y descripción. La tarea debe conservar el segmento seleccionado, sus registros y el siguiente paso solicitado.

1. Crea un tablero y una lista de prácticas propios.
2. En [trello.com/apps/admin](https://trello.com/apps/admin), crea una app con **My app doesn't use Power-up capabilities**. Completa nombre, Workspace y emails.
3. En **Trello Auth**, pulsa **Generate a new Trello Auth API key for this app**.
4. Pulsa **Token**, revisa cuenta, permisos read/write y duración, y pulsa **Allow**.
5. Para obtener la lista, abre una tarjeta temporal dentro de ella, añade `.json` al final de su URL y copia el valor de `idList`, sin comillas. No copies el ID de la tarjeta.

| Variable en Vercel | Valor |
| --- | --- |
| `TRELLO_API_KEY` | API key de la pestaña Trello Auth. |
| `TRELLO_TOKEN` | Token mostrado después de Allow. |
| `TRELLO_LIST_ID` | `idList` de tu lista de prácticas. |

Usa **Trello Auth**, no OAuth 2.0. No hacen falta Secret, Client ID, callback ni Allowed origins para este flujo manual. El token puede actuar sobre otros tableros accesibles de la cuenta; usa un destino de prácticas. [Autorización oficial](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).

**Comprobación:** abre la tarjeta real y contrasta lista, título, descripción, segmento y registros. Una tarjeta creada no demuestra que el problema de datos se haya resuelto.

## 3 · Record: corregir una cifra real en Supabase

**Caso incluido:** abre NS-1041 con **Details →**. Su nota de auditoría identifica **$240 de transporte duplicado**. En un proyecto nuevo, coste inicial **1320**; coste corregido **1080**; contribución **−120 → +120**. No se marca simplemente «revisado»: cambia el número guardado y las métricas que dependen de él.

### Preparación de tu propio proyecto

Los archivos están incluidos; copiar la web no crea la tabla ni despliega la función automáticamente. Configura esta parte con el profesor o asistente.

1. Abre tu proyecto de prácticas en [Supabase](https://supabase.com/dashboard). En **SQL Editor**, ejecuta [supabase/orders-setup.sql](../supabase/orders-setup.sql). Crea **`public.ie_action_lab_order_values`** con las cifras de 24 registros, revisión inicial 0 y permisos solo de servidor. Volver a ejecutar el seed no sobrescribe correcciones existentes.
2. Abre [supabase/orders/index.ts](../supabase/orders/index.ts). El marcador `EXPECTED_ACCESS_KEY_SHA256` debe sustituirse por la huella SHA-256 de tu propia `LAB_ACCESS_KEY` de 32–256 caracteres. El profesor/asistente debe calcularla mediante una herramienta local o acceso autorizado a los ajustes; no pegues la contraseña en el chat ni la publiques en el archivo.
3. Despliega el archivo como Edge Function **`ie-action-lab-orders`**. Utiliza **Verify JWT desactivado** únicamente conservando la comprobación propia de acceso y con la huella configurada. `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` permanecen dentro del servidor de Supabase.
4. Añade la URL del proyecto en Vercel, conserva la misma clave del laboratorio y redespliega la app.

| Variable en Vercel | Valor |
| --- | --- |
| `LAB_SUPABASE_URL` | `https://TU_PROYECTO.supabase.co`, sin ruta ni barra final. |
| `LAB_ACCESS_KEY` | La contraseña cuya huella configuraste en la función. |

Petición útil para el asistente:

> Con mi copia abierta, ayúdame a desplegar supabase/orders-setup.sql y supabase/orders/index.ts en mi propio proyecto. Explícame cada pantalla y conserva la autenticación y el control de revisiones. Prepara la huella de la clave por un canal local o autorizado, nunca pidiéndome secretos en el chat. Verifica que hay 24 registros y que el endpoint ie-action-lab-orders los lee. Si no tienes acceso, dime la operación concreta que debo hacer.

### Ejercicio y comprobación

En el detalle del registro, pulsa la **celda numérica Product cost** y edita su valor directamente: introduce **1080** y explica el transporte duplicado. Puedes corregir revenue, cost o refund; la cifra debe ser válida, no negativa, y el reembolso no puede superar los ingresos. Revisa el antes/después, confirma y observa cómo cambia la contribución.

El servidor compara **valor anterior y revisión**. Si otra persona cambió el registro mientras lo revisabas, devuelve un conflicto y no pisa el cambio: refresca y vuelve a revisar. Después de escribir, consulta la base de datos de nuevo antes de confirmar el éxito.

**Comprobación:** recarga la página, introduce otra vez la frase del laboratorio y pulsa **Refresh data & connections**. Abre NS-1041: debe conservar coste 1080 y contribución +120. Contrasta la fila en Supabase **Table Editor → ie_action_lab_order_values**, incluida su revisión. Con el caso original, el coste total baja 240 y la contribución total sube 240. El historial local del navegador no es prueba de persistencia.

Esta función y tabla son nuevas. Los antiguos `setup.sql`, `writeback/index.ts`, `ie-action-lab-writeback` y `ie_action_lab_reviews` solo servían para estado de revisión y no se usan en este ejercicio.

## 4 · Record: reportar el problema mediante un issue de GitHub

**En la app:** desde la fila del registro o su contexto de auditoría, elige **Report data issue**. Edita título y descripción para explicar el cargo duplicado, la cifra anterior/corregida y qué debe revisar el proceso de importación. Se abre un **issue**, no una PR: no se crean ramas, commits ni se modifica código.

1. Usa tu propia copia del repositorio. Abre [crear token de prácticas](https://github.com/settings/personal-access-tokens/new?name=IE%20Action%20Lab&expires_in=7&issues=write).
2. Elige tu cuenta como **Resource owner**. En **Repository access**, marca **Only select repositories** y selecciona tu copia, aunque sea pública. **Public repositories** es solo lectura.
3. En **Permissions → + junto a Repository**, añade **Issues → Read and write**. Metadata read-only se incluye automáticamente. Este ejercicio no necesita Contents ni Pull requests.
4. Guarda el token y el nombre de tu repositorio en Vercel y redespliega.

| Variable | Valor |
| --- | --- |
| `LAB_GITHUB_TOKEN` | Token restringido a tu copia, con Issues read/write. |
| `LAB_GITHUB_REPOSITORY` | `TU-USUARIO/TU-REPOSITORIO`, sin la URL de GitHub. |

**Comprobación:** abre el issue real y compara título, cuerpo, registro y evidencia. Reportarlo no corrige los datos por sí mismo ni garantiza que la importación se haya arreglado.

## Evidencia y cierre

La interacción revisada desde el KPI, la barra y la celda se está comprobando por separado. Las pruebas siguientes demuestran las integraciones; no acreditan nuevas ejecuciones reales mediante los controles revisados.

**Las cuatro integraciones pasaron pruebas reales el 17 de noviembre de 2026**, sobre el despliegue anterior del commit `fef782e984cfb9e907b00e9c488de9dfcabede36`.

| Acción | Evidencia observada |
| --- | --- |
| Email del overview | Mensaje real en Gmail con el texto editado y el request ID coincidentes. |
| Trello del segmento | [Tarjeta jpJ4XnYL](https://trello.com/c/jpJ4XnYL), recuperada con GET y contenido/destino exactos. |
| Corrección Supabase | Coste 1320 → 1080, revisión 1, contribución del registro 120 y total 7.773. La recarga de la UI y una consulta SQL independiente coincidieron con la petición. |
| GitHub issue del registro | [Issue #2](https://github.com/josncmar/ie-apps-action-lab/issues/2), comprobado con GET y texto editado/request ID exactos. |

La app del profesor conserva ahora coste **1080**. Los proyectos nuevos siembran **1320** para el ejercicio y no heredan su base de datos; volver a ejecutar el seed no pisa correcciones existentes. No reviertas la corrección del profesor solo para recrear la señal. Cada alumno debe configurar y comprobar su propia copia.

Guarda la evidencia de los cuatro puntos: email de la vista, tarjeta del segmento, cifra persistida con métricas recalculadas e issue del registro. Ante un resultado desconocido, comprueba el destino antes de repetir; ante un conflicto numérico, refresca primero. Al terminar, borra la frase del navegador y revoca los tokens temporales que ya no necesites.

La demo ntfy y los borradores de email/Teams quedan como extras opcionales; no son el recorrido principal ni prueban estas cuatro acciones.
