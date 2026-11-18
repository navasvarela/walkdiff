import { describe, expect, it } from "vitest"
import type { ApiChange } from "./apiChange.ts"
import { OPEN_API } from "./openApi.ts"

/** Compares one file's two versions. */
function compare(before: string, after: string): ApiChange[] {
  return OPEN_API.compare([{ path: "api.yaml", text: before }], [{ path: "api.yaml", text: after }])
}

function summary(changes: readonly ApiChange[]): string[] {
  return changes.map((change) => `${change.kind} ${change.subject}${change.change === undefined ? "" : ` (${change.change})`}@${change.line ?? "-"}`)
}

const BEFORE = `openapi: 3.0.3
info: { title: Users, version: "1" }
paths:
  /users:
    get:
      parameters:
        - { name: limit, in: query, schema: { type: integer } }
        - { name: sort, in: query, schema: { type: string, enum: [name, age] } }
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items: { $ref: "#/components/schemas/User" }
    post:
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/NewUser" }
      responses:
        "201": { description: created }
  /users/{id}:
    delete:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "204": { description: gone }
components:
  schemas:
    User:
      type: object
      required: [id, email]
      properties:
        id: { type: string }
        email: { type: string }
        age: { type: integer }
    NewUser:
      type: object
      required: [email]
      properties:
        email: { type: string }
        name: { type: string }
`

describe("OpenAPI", () => {
  it("recognises specs by their version key, in YAML or JSON", () => {
    expect(OPEN_API.matches("api/openapi.yaml", BEFORE)).toBe(true)
    expect(OPEN_API.matches("swagger.json", '{ "swagger": "2.0", "paths": {} }')).toBe(true)
    expect(OPEN_API.matches("config.yaml", "server: { port: 8080 }")).toBe(false)
  })

  it("flags removed operations, new required inputs, removed enum values and response fields", () => {
    const after = BEFORE
      .replace("        - { name: sort, in: query, schema: { type: string, enum: [name, age] } }", "        - { name: sort, in: query, schema: { type: string, enum: [name] } }\n        - { name: tenant, in: header, required: true, schema: { type: string } }")
      .replace("        email: { type: string }\n        age: { type: integer }", "        email: { type: string }\n        age: { type: string }")
      .replace("      required: [email]\n      properties:\n        email: { type: string }\n        name: { type: string }", "      required: [email, name]\n      properties:\n        email: { type: string }\n        name: { type: string }")
      .replace(/ {2}\/users\/\{id\}:[\s\S]*?"204": \{ description: gone \}\n/, "")
    expect(summary(compare(BEFORE, after))).toEqual([
      "enum-value-removed GET /users query sort parameter = age@5",
      "required-added GET /users header tenant parameter@5",
      "type-changed GET /users response: age (integer to string)@5",
      "became-required POST /users request: name@17",
      "operation-removed DELETE /users/{id}@3",
    ])
  })

  it("leaves additions clients can ignore alone", () => {
    const after = BEFORE
      .replace("        - { name: limit, in: query, schema: { type: integer } }", "        - { name: limit, in: query, schema: { type: integer } }\n        - { name: page, in: query, schema: { type: integer } }")
      .replace("        age: { type: integer }", "        age: { type: integer }\n        createdAt: { type: string }")
      .replace("enum: [name, age]", "enum: [name, age, createdAt]")
    expect(compare(BEFORE, after)).toEqual([])
  })

  it("reads Swagger 2 bodies and parameters", () => {
    const swagger = (required: string): string => `{
  "swagger": "2.0",
  "paths": { "/orders": { "post": {
    "parameters": [{ "name": "body", "in": "body", "schema": { "type": "object", "required": [${required}], "properties": { "sku": { "type": "string" }, "qty": { "type": "integer" } } } }],
    "responses": { "200": { "schema": { "type": "object", "properties": { "id": { "type": "string" } } } } }
  } } }
}`
    expect(summary(compare(swagger('"sku"'), swagger('"sku", "qty"')))).toEqual(["became-required POST /orders request: qty@3"])
  })

  it("rates a removed operation or response field as breaking deployed clients", () => {
    const after = BEFORE.replace("        age: { type: integer }\n", "")
    expect(compare(BEFORE, after)).toEqual([expect.objectContaining({ kind: "field-removed", subject: "GET /users response: age", breaksDeployedClients: true })])
  })

  it("throws on a spec it can't read", () => {
    expect(() => compare(BEFORE, "openapi: [unclosed")).toThrow()
  })
})
