# Contexto de la conversación anterior

Una LEIA usa el contexto anterior cuando su behaviour contiene
`{{reflectiveContext.previousConversation}}` o
`{{reflectiveContext.previousSolution}}`. Debe haber otra LEIA antes en la
actividad. Se admiten LEIAs consecutivas que usen ese contexto. El flujo es
secuencial y la LEIA que usa contexto debe ser interactiva.

La conversación y la solución anterior (si existe) se copian a la sesión
siguiente. Runner resuelve las variables en una copia inmutable de la LEIA.
El texto del alumno se inserta como dato y no se vuelve a interpretar como
plantilla. La LEIA original de la actividad no cambia.

## Behaviour

```json
{
  "apiVersion": "v1",
  "metadata": { "name": "entrevista" },
  "spec": {
    "description": "Pregunta por las decisiones tomadas. Conversación: {{reflectiveContext.previousConversation}}. Solución: {{reflectiveContext.previousSolution}}.",
    "conversationDynamics": {
      "stoppingCondition": {
        "enabled": true,
        "prompt": "Termina cuando haya explicado dos decisiones."
      },
      "speaksFirst": {
        "enabled": true,
        "prompt": "Empieza preguntando por la primera decisión."
      }
    }
  }
}
```

`conversationDynamics.stoppingCondition` y `conversationDynamics.speaksFirst`
son opciones independientes. Al activar la primera, su `prompt` es obligatorio
y se añade a las instrucciones del modelo; el usuario
puede cerrar la sesión con el control habitual. `problem.spec.evaluationPrompt`
sigue sirviendo exclusivamente para la evaluación automática de soluciones.
En Workbench, pedir y evaluar una solución se configura igual para todas las
LEIAs.

Al terminar una sesión cuya siguiente LEIA usa contexto, Workbench ofrece
continuar. La API existente `POST /api/v1/interactions/:id/reflective`
crea o recupera la siguiente sesión. `reflectiveAvailable` indica si hay
una continuación disponible. El nombre de estos contratos se conserva por
compatibilidad de clientes; no existe ningún flag de comportamiento reflexivo.

`POST /api/v1/interactions/:id/opening` genera el primer mensaje cuando
`conversationDynamics.speaksFirst.enabled` está activo y aún no hay mensajes. Las repeticiones devuelven
el mensaje ya guardado. Se espera a resolver cualquier consentimiento de
uso de datos antes de solicitarlo.

Las pruebas se ejecutan con `npx vitest run` en Designer Backend, Runner
y Workbench Backend, y con `npm run build` en ambas interfaces.
