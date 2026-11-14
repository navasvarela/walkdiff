import { describe, expect, it } from "vitest"
import { findIdentifierUses } from "../impact/identifierUses.ts"
import { csharpSpec } from "./csharp.ts"
import { extractUnits } from "./definitions.ts"
import type { Definition, FileUnits } from "./definitions.ts"
import { kotlinSpec } from "./kotlin.ts"
import type { LanguageSpec } from "./languageSpec.ts"
import { languageSpecFor } from "./languages.ts"
import { withSyntaxTree } from "./parser.ts"

function unitsOf(spec: LanguageSpec, source: string): Promise<FileUnits> {
  return withSyntaxTree(spec, source, (tree) => extractUnits(spec, tree, source))
}

async function outline(spec: LanguageSpec, source: string): Promise<string[]> {
  return (await unitsOf(spec, source)).definitions.map((definition) => `${definition.kind} ${definition.qualifiedName}${definition.isPublic ? " (public)" : ""}`)
}

async function unitNamed(spec: LanguageSpec, source: string, qualifiedName: string): Promise<Definition> {
  const found = (await unitsOf(spec, source)).definitions.find((definition) => definition.qualifiedName === qualifiedName)
  if (found === undefined) throw new Error(`no unit ${qualifiedName}`)
  return found
}

function usesOf(spec: LanguageSpec, source: string, name: string): Promise<string[]> {
  return withSyntaxTree(spec, source, (tree) =>
    findIdentifierUses(spec, tree, new Set([name])).map((occurrence) => {
      const detail = "qualifier" in occurrence.use ? occurrence.use.qualifier : "receiver" in occurrence.use ? occurrence.use.receiver : ""
      return `${occurrence.line} ${occurrence.use.kind}${detail === "" ? "" : ` ${detail}`}`
    }),
  )
}

const KOTLIN_SOURCE = `package com.acme.server

/** Serves. */
@Service
class Server(private val port: Int) : Base() {
    companion object { const val LIMIT = 10 }
    fun start(a: Int, vararg rest: String): Int {
        if (a > 0 && rest.isEmpty()) throw IllegalStateException("x")
        val f = { x: Int -> x + 1 }
        return helper(a)
    }
    private fun helper(b: Int = 2) = b
    inner class Inner { fun go() {} }
}
interface Listener { fun on(x: Int) }
object Registry { fun all(): List<Server> = emptyList() }
enum class Mode { FAST, SLOW }
data class Point(val x: Int, val y: Int)
typealias Handler = (Int) -> Unit
val DEFAULT_PORT = 8080
fun String.shout(): String = uppercase()
internal fun hidden() {}
`

const CSHARP_SOURCE = `using System;
namespace Acme.Server
{
    /// <summary>Serves.</summary>
    [Service]
    public class Server : Base, IDisposable
    {
        public Server(int port) { }
        public int Start(int a, params string[] rest)
        {
            if (a > 0 && rest.Length == 0) throw new InvalidOperationException("x");
            Func<int, int> f = x => x + 1;
            return Helper(a);
        }
        private int Helper(int b = 2) => b;
        public void Dispose() { }
        ~Server() { }
        internal class Inner { void Go() { } }
    }
    public interface IListener { void On(int x); }
    public enum Mode { Fast, Slow }
    public record Point(int X, int Y);
    public struct Size { public int W; }
    public static class Strings { public static string Shout(this string s) => s.ToUpper(); }
}
`

describe("Kotlin", () => {
  it("extracts classes, objects, interfaces and their members, extensions by their type, and top-level values", async () => {
    expect(await outline(kotlinSpec, KOTLIN_SOURCE)).toEqual([
      "class Server (public)",
      "class Server.Companion (public)",
      "method Server.start (public)",
      "method Server.helper",
      "class Server.Inner (public)",
      "method Server.Inner.go (public)",
      "interface Listener (public)",
      "method Listener.on (public)",
      "class Registry (public)",
      "method Registry.all (public)",
      "enum Mode (public)",
      "class Point (public)",
      "typeAlias Handler (public)",
      "constant DEFAULT_PORT (public)",
      "function String.shout (public)",
      "function hidden",
    ])
  })

  it("reads vararg and default parameters, the return type, calls and throws", async () => {
    const start = (await unitNamed(kotlinSpec, KOTLIN_SOURCE, "Server.start")).shape
    expect(start?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["a:required", "rest:rest"])
    expect(start?.returnType).toBe("Int")
    expect([...(start?.calls ?? [])]).toEqual(["rest.isEmpty", "IllegalStateException", "helper"])
    expect(start?.errorPaths).toBe(1)
    expect(start?.metrics.complexity).toBe(3)
    const helper = (await unitNamed(kotlinSpec, KOTLIN_SOURCE, "Server.helper")).shape
    expect(helper?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["b:optional"])
  })

  it("counts member, this and bare calls as uses, but not declarations or parameters", async () => {
    const source = ["fun start() {}", "fun run(server: Server, start: Int) { server.start(); this.start(); start }", "fun go() { start() }"].join("\n")
    expect(await usesOf(kotlinSpec, source, "start")).toEqual(["2 member server", "2 member this", "3 bare"])
  })

  it.each(["app/src/main/kotlin/Server.kt", "build.gradle.kts"])("is chosen for %s", (path) => {
    expect(languageSpecFor(path)).toBe(kotlinSpec)
  })
})

describe("C#", () => {
  it("extracts namespaces, types and their members, with constructors and destructors", async () => {
    expect(await outline(csharpSpec, CSHARP_SOURCE)).toEqual([
      "module Acme.Server (public)",
      "class Acme.Server.Server (public)",
      "method Acme.Server.Server.Server (public)",
      "method Acme.Server.Server.Start (public)",
      "method Acme.Server.Server.Helper",
      "method Acme.Server.Server.Dispose (public)",
      "method Acme.Server.Server.~Server",
      "class Acme.Server.Server.Inner",
      "method Acme.Server.Server.Inner.Go",
      "interface Acme.Server.IListener (public)",
      "method Acme.Server.IListener.On (public)",
      "enum Acme.Server.Mode (public)",
      "class Acme.Server.Point (public)",
      "struct Acme.Server.Size (public)",
      "class Acme.Server.Strings (public)",
      "method Acme.Server.Strings.Shout (public)",
    ])
  })

  it("names declarations after a file-scoped namespace by it", async () => {
    expect(await outline(csharpSpec, "namespace Acme.Tools;\n\npublic class Runner { public void Run() { } }\n")).toEqual(["class Acme.Tools.Runner (public)", "method Acme.Tools.Runner.Run (public)"])
  })

  it("reads params, defaults, the extension receiver, the return type, calls and throws", async () => {
    const start = (await unitNamed(csharpSpec, CSHARP_SOURCE, "Acme.Server.Server.Start")).shape
    expect(start?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["a:required", "rest:rest"])
    expect(start?.returnType).toBe("int")
    expect([...(start?.calls ?? [])]).toEqual(["InvalidOperationException", "Helper"])
    expect(start?.errorPaths).toBe(1)
    expect(start?.metrics.complexity).toBe(3)
    const helper = (await unitNamed(csharpSpec, CSHARP_SOURCE, "Acme.Server.Server.Helper")).shape
    expect(helper?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["b:optional"])
    const shout = (await unitNamed(csharpSpec, CSHARP_SOURCE, "Acme.Server.Strings.Shout")).shape
    expect(shout?.signature.map((parameter) => `${parameter.name}:${parameter.kind}`)).toEqual(["s:receiver"])
    expect(shout?.metrics.parameters).toBe(1)
  })

  it("counts member, path and bare calls as uses, but not declarations or parameters", async () => {
    const source = ["class A {", "  void Start() { }", "  void Run(Server server, int Start) { server.Start(); Server.Start(); this.Start(); Start = 1; }", "  void Go() { Start(); }", "}"].join("\n")
    expect(await usesOf(csharpSpec, source, "Start")).toEqual(["3 member server", "3 member Server", "3 member this", "4 bare"])
  })

  it("is chosen for .cs files", () => {
    expect(languageSpecFor("src/Acme.Server/Server.cs")).toBe(csharpSpec)
  })
})
