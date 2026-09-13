# LEIA Reflexiva — fase 1

Implementación basada en `.agents/FASE 1.md` del TFG (09/09/2026).

## Uso

1. En Designer, crea un behaviour y activa **Reflective LEIA**. Rellena **Evaluation objective** y **Stopping instructions**. Compón una LEIA con ese behaviour, persona y problema.
2. En una actividad añade primero la LEIA normal (LN) y, justo después, la reflexiva (LR). El orden de la lista define la pareja. Se permiten varias parejas y LEIAs normales independientes. No se permite una LR aislada, dos LRs consecutivas ni combinar la cadena con la conversación simultánea MultiLEIA.
3. Crea la replicación en Workbench y configura sus modelos y claves. En **Settings → Reflective LEIA**, activa el switch. La LN anterior debe tener activada la recogida de solución. Las LRs tienen desactivadas la recogida y la evaluación automática de una nueva solución.
4. El alumno realiza la LN y entrega su solución. Aparece **Continue with Reflective LEIA**, que inicia la entrevista. Al volver a entrar con su correo y el código también puede recuperar la continuación pendiente, aunque la replicación no sea repetible.
5. La LR entrevista sobre la solución anterior. Cuando alcanza la pauta de parada, el modelo concluye y deja de preguntar; el alumno termina con el botón habitual. La parada es una instrucción al modelo: no hay detector determinista ni bucle agéntico en esta fase.

El switch afecta a entrevistas nuevas. Las ya iniciadas pueden reanudarse. Una LN terminada sin solución (por ejemplo, por agotarse el tiempo) no inicia una LR: no se sustituye la entrega por un borrador o una solución de referencia. Probar una LR desde Workbench inicia primero su LN para obtener datos reales de prueba.

## Behaviour

```json
{
  "apiVersion": "v1",
  "metadata": { "name": "entrevista-reflexiva" },
  "spec": {
    "reflective": true,
    "description": "Entrevista al estudiante sobre sus decisiones. Conversación anterior: {{reflectiveContext.previousConversation}}. Solución entregada: {{reflectiveContext.previousSolution}}.",
    "evaluationPrompt": "Comprueba si comprende las relaciones del modelo y puede justificar sus decisiones de diseño.",
    "stoppingPrompt": "Concluye cuando haya justificado dos decisiones y explicado una alternativa, o después de seis preguntas."
  }
}
```

`behaviour.spec.evaluationPrompt` es distinto de `problem.spec.evaluationPrompt`, que sigue perteneciendo a la evaluación automática tradicional. Los dos prompts reflexivos son obligatorios y no admiten texto vacío. Las variables dinámicas se conservan durante la composición en Designer. La entrevista también recibe el contexto cuando el autor no incluye las variables en la descripción.

## Contexto e instancia

- Workbench recibe la referencia a la sesión LN, carga su conversación en orden cronológico y su `result` final.
- `buildReflectiveContext` aplica filtros secuenciales sobre un objeto vacío: `meteConversacion` y `meteSolucion`. Los filtros son sustituibles para futuras fuentes de contexto.
- Se guarda una copia de la definición con su contexto en `Session.leiaSnapshot`, junto con `previousSession`. Ambos campos son inmutables; un índice único y disperso sobre `previousSession` evita continuaciones duplicadas. La copia no se serializa hacia el alumno.
- Runner clona esa definición, resuelve las variables y congela la instancia recursivamente antes de construir las instrucciones. Los datos insertados no se vuelven a interpretar como plantillas y se describen al modelo como datos, no instrucciones. No se modifica la LEIA de la actividad.
- Luke y Realtime construyen sus instrucciones desde la misma copia. El pequeño módulo de runtime está replicado en Workbench y Runner porque son repositorios desplegados por separado; mantener ambas copias sincronizadas.
- La distribución inicial selecciona únicamente LNs. Las LRs se alcanzan por su predecesora; los reintentos reutilizan la sesión existente y su contexto original.

## API

- `PATCH /api/v1/replications/:id/toggle-reflective`: usa la autorización existente de la replicación.
- `POST /api/v1/interactions/:previousSessionId/reflective`: inicia o recupera la continuación. Sigue el modelo de acceso por identificador de sesión de los demás endpoints del alumno.
- El login admite `?previousSessionId=<id>&code=<código>`; envía la referencia en `POST /api/v1/interactions`. El servidor verifica que la sesión corresponde al correo y a la replicación indicados.
- `GET /api/v1/interactions/:id` y la respuesta a la entrega incluyen `reflectiveAvailable` cuando procede. No exponen los prompts reflexivos ni la copia privada del contexto.
- Runner acepta `reflectiveContext` en `POST /api/v1/leias` para integraciones internas. Una LR sin contexto se rechaza con HTTP 400. Una prueba aislada desde Designer no dispone de la LN previa: utilizar la prueba encadenada de Workbench.

No se implementan en esta fase criterios de rúbrica, etiquetas de clasificación ni un bucle agéntico. No se necesitan migraciones de datos existentes; `reflectiveEnabled` es falso por defecto. El índice de sesiones debe existir en MongoDB antes de habilitar el flujo (Mongoose lo crea cuando `autoIndex` está habilitado).

## Verificación local

```text
leia-designer-backend: npm test -- --run
leia-workbench-backend: npm test -- --run
leia-runner: npm run test:unit
leia-designer-frontend: npm run build
leia-workbench-frontend: npm run build
```

Las pruebas cubren autoría, variables estáticas y dinámicas, orden de filtros, aislamiento entre alumnos, inmutabilidad, cadena LN/LR, reanudación, reintentos y rechazo de nuevas entregas. Las pruebas unitarias simulan persistencia y proveedores; no ejecutan entrevistas contra modelos externos.
