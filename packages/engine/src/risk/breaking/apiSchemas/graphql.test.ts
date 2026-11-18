import { describe, expect, it } from "vitest"
import type { ApiChange } from "./apiChange.ts"
import { GRAPHQL } from "./graphql.ts"

/** Compares one file's two versions. */
function compare(before: string, after: string): ApiChange[] {
  return GRAPHQL.compare([{ path: "schema.graphql", text: before }], [{ path: "schema.graphql", text: after }])
}

function summary(changes: readonly ApiChange[]): string[] {
  return changes.map((change) => `${change.kind} ${change.subject}${change.change === undefined ? "" : ` (${change.change})`}@${change.line ?? "-"}`)
}

const BEFORE = `type Query {
  users(first: Int, after: String): [User!]!
  user(id: ID!): User
}

type User {
  id: ID!
  email: String!
  age: Int
  role: Role!
}

enum Role {
  ADMIN
  MEMBER
  GUEST
}

input NewUser {
  email: String!
  name: String
}

type Legacy {
  id: ID!
}
`

describe("GraphQL", () => {
  it("flags removed types, fields, arguments and enum values, and inputs that became required", () => {
    const after = `type Query {
  users(first: Int!): [User!]!
  user(id: ID!, tenant: ID!): User
}

type User {
  id: ID!
  email: String
  age: Float
  role: Role!
}

enum Role {
  ADMIN
  MEMBER
}

input NewUser {
  email: String!
  name: String!
  invitedBy: ID!
}
`
    expect(summary(compare(BEFORE, after))).toEqual([
      "field-removed Query.users(after:)@2",
      "became-required Query.users(first:)@2",
      "required-added Query.user(tenant:)@3",
      "became-optional User.email@8",
      "type-changed User.age (Int to Float)@9",
      "enum-value-removed Role.GUEST@13",
      "became-required NewUser.name@20",
      "required-added NewUser.invitedBy@21",
      "type-removed Legacy@-",
    ])
  })

  it("leaves additions and safe tightening alone", () => {
    const after = BEFORE.replace("  age: Int\n", "  age: Int!\n  nickname: String\n")
      .replace("  GUEST\n", "  GUEST\n  OWNER\n")
      .replace("  name: String\n", "  name: String\n  locale: String = \"en\"\n")
      .replace("user(id: ID!): User", "user(id: ID!, includeDeleted: Boolean = false): User")
    expect(compare(BEFORE, after)).toEqual([])
  })

  it("merges extensions into the type they extend", () => {
    const before = "type Query { a: Int }\nextend type Query { b: Int }\n"
    expect(summary(compare(before, "type Query { a: Int }\n"))).toEqual(["field-removed Query.b@1"])
  })

  it("follows a type that moved to another file, and places its changes there", () => {
    const before = [{ path: "a.graphql", text: "type Query { me: User }\ntype User { id: ID!, email: String }\n" }]
    const after = [
      { path: "a.graphql", text: "type Query { me: User }\n" },
      { path: "b.graphql", text: "type User {\n  id: ID!\n}\n" },
    ]
    expect(GRAPHQL.compare(before, after).map((change) => `${change.kind} ${change.subject} ${change.path}:${change.line ?? "-"}`)).toEqual(["field-removed User.email b.graphql:1"])
  })

  it("names the file it couldn't read", () => {
    expect(() => GRAPHQL.compare([{ path: "a.graphql", text: "type A { id: ID }" }], [{ path: "a.graphql", text: "type A {" }])).toThrow(/^a\.graphql: /)
  })

  it("reads a deleted file as defining nothing", () => {
    expect(summary(compare("type Gone { id: ID }", ""))).toEqual(["type-removed Gone@-"])
  })
})
