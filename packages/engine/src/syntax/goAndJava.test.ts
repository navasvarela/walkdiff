import { describe, expect, it } from "vitest"
import { extractUnits } from "./definitions.ts"
import type { Definition, FileUnits } from "./definitions.ts"
import { goSpec } from "./go.ts"
import { javaSpec } from "./java.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { languageSpecFor } from "./languages.ts"
import { withSyntaxTree } from "./parser.ts"

function unitsOf(spec: LanguageSpec, source: string): Promise<FileUnits> {
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

async function outline(spec: LanguageSpec, source: string): Promise<string[]> {
  const units = await unitsOf(spec, source)
  return units.definitions.map((definition) => `${definition.kind} ${definition.qualifiedName}${definition.isPublic ? " (public)" : ""}`)
}

async function unitNamed(spec: LanguageSpec, source: string, qualifiedName: string): Promise<Definition> {
  const found = (await unitsOf(spec, source)).definitions.find((definition) => definition.qualifiedName === qualifiedName)
  if (found === undefined) throw new Error(`no unit ${qualifiedName}`)
  return found
}

const GO_SOURCE = `package server

import "context"

// Server serves.
type Server struct{ addr string }

type (
	Reader interface {
		Read(p []byte) (n int, err error)
	}
	ID = string
	handler func()
)

const Limit = 10
const a, b = 1, 2

var newHandler = func() handler { return nil }

func (s *Server[T]) Start(ctx context.Context, a, b int, rest ...string) (int, error) {
	if err := run(); err != nil && a > 0 {
		panic(err)
	}
	go func() { local() }()
	return pkg.Call(a), nil
}

func (s server) hidden() {}

func New() *Server { return &Server{addr: ""} }
`

const JAVA_SOURCE = `package com.example;

import java.util.List;

/** Serves. */
@Service
public class Server extends Base {
  private static final int LIMIT = 10;
  private final Runnable task = new Runnable() { public void run() {} };

  public Server(String addr) { super(addr); }

  @Override
  public List<String> start(final int a, String... rest) throws IOException {
    if (a > 0 && rest.length == 0) throw new IllegalStateException("x");
    Runnable f = () -> run();
    return List.of(String.valueOf(a));
  }

  static class Inner { void go() {} }

  public interface Listener { void on(int x); private void helper() {} }

  enum Mode { FAST { int speed() { return 2; } }, SLOW; int speed() { return 1; } }

  public record Point(int x, int y) { public Point { if (x < 0) throw new IllegalArgumentException(); } }
}

class PackagePrivate { public void visible() {} }
`

describe("Go", () => {
  it("extracts types, interface methods, functions, methods named by their type, and package values", async () => {
    expect(await outline(goSpec, GO_SOURCE)).toEqual([
      "struct Server (public)",
      "interface Reader (public)",
      "method Reader.Read (public)",
      "typeAlias ID (public)",
      "typeAlias handler",
      "constant Limit (public)",
      "function newHandler",
      "method Server.Start (public)",
      "method server.hidden",
      "function New (public)",
    ])
  })

  it("makes nothing in package main public", async () => {
    expect(await outline(goSpec, "package main\n\nfunc Run() {}\n")).toEqual(["function Run"])
  })

  it("keeps a single declaration's doc comment and keyword with its unit", async () => {
    const server = await unitNamed(goSpec, GO_SOURCE, "Server")
    expect(server.snapshot.text).toBe("// Server serves.\ntype Server struct{ addr string }")
  })

  it("reads each name of a grouped parameter, variadics, and the result", async () => {
    const shape = (await unitNamed(goSpec, GO_SOURCE, "Server.Start")).shape
    expect(shape?.signature.map((parameter) => `${parameter.name}:${parameter.kind}:${parameter.type}`)).toEqual([
      "ctx:required:context.Context",
      "a:required:int",
      "b:required:int",
      "rest:rest:string",
    ])
    expect(shape?.returnType).toBe("(int, error)")
    expect([...(shape?.calls ?? [])]).toEqual(["run", "panic", "local", "pkg.Call"])
    expect(shape?.errorPaths).toBe(1)
    expect(shape?.metrics.complexity).toBe(3)
  })

  it("is chosen for .go files", () => {
    expect(languageSpecFor("cmd/server/main.go")).toBe(goSpec)
  })
})

describe("Java", () => {
  it("extracts types and their methods, leaving anonymous classes, lambdas and enum constant bodies inside", async () => {
    expect(await outline(javaSpec, JAVA_SOURCE)).toEqual([
      "class Server (public)",
      "method Server.Server (public)",
      "method Server.start (public)",
      "class Server.Inner",
      "method Server.Inner.go",
      "interface Server.Listener (public)",
      "method Server.Listener.on (public)",
      "method Server.Listener.helper",
      "enum Server.Mode",
      "method Server.Mode.speed",
      "class Server.Point (public)",
      "method Server.Point.Point (public)",
      "class PackagePrivate",
      "method PackagePrivate.visible",
    ])
  })

  it("keeps annotations with their declaration", async () => {
    const start = await unitNamed(javaSpec, JAVA_SOURCE, "Server.start")
    expect(start.snapshot.text.split("\n").at(0)?.trim()).toBe("@Override")
  })

  it("reads parameters, varargs, the return type and throws", async () => {
    const shape = (await unitNamed(javaSpec, JAVA_SOURCE, "Server.start")).shape
    expect(shape?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["a:required", "rest:rest"])
    expect(shape?.returnType).toBe("List<String>")
    expect(shape?.errorPaths).toBe(1)
    expect(shape?.calls).toContain("IllegalStateException")
    expect(shape?.metrics.complexity).toBe(3)
  })

  it("is chosen for .java files", () => {
    expect(languageSpecFor("src/main/java/com/example/Server.java")).toBe(javaSpec)
  })
})
